import {
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

export interface CallRecording {
  id: string;
  status: number;
  files?: { filename: string; size: string }[];
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const unavailableMessage =
  'Не удалось связаться с сервисом звонков. Повторите попытку.';

function retryDelay(attempt: number, retryAfter: string | null) {
  const base = Math.min(250 * 2 ** attempt, 4000);
  const backoff = base + Math.floor(Math.random() * base * 0.25);
  const requested =
    retryAfter === null
      ? 0
      : /^\d+(\.\d+)?$/.test(retryAfter.trim())
        ? Number(retryAfter) * 1000
        : Date.parse(retryAfter) - Date.now();
  return Math.max(
    backoff,
    Number.isFinite(requested) ? Math.min(Math.max(0, requested), 8000) : 0,
  );
}

@Injectable()
export class CallsClient {
  constructor(private readonly config: ConfigService) {}
  get configured() {
    return Boolean(
      this.config.get('CALLS_SERVICE_URL') &&
      (this.config.get<string>('CALLS_SERVICE_SECRET')?.length ?? 0) >= 32,
    );
  }
  authorized(header: unknown) {
    const secret = this.config.get<string>('CALLS_SERVICE_SECRET');
    if (!secret || secret.length < 32 || typeof header !== 'string')
      return false;
    const a = Buffer.from(header),
      b = Buffer.from('Bearer ' + secret);
    return a.length === b.length && timingSafeEqual(a, b);
  }
  async request<T>(
    room: string,
    path: string,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    if (!this.configured)
      throw new ServiceUnavailableException({
        code: 'UPSTREAM_REQUEST_FAILED',
        message: 'Сервис звонков ещё не настроен.',
      });
    method = method.toUpperCase();
    // Only replay reads and known idempotent room operations. Recording and
    // transcription requests can create new work and must not be repeated here.
    const participantAction =
      body && typeof body === 'object' && 'action' in body
        ? body.action
        : undefined;
    const safeParticipantAction =
      path === '/participant' &&
      typeof participantAction === 'string' &&
      // A delayed permissions:true retry could override a newer revocation.
      ['remove', 'mute'].includes(participantAction);
    const safe =
      method === 'GET' ||
      method === 'HEAD' ||
      (method === 'POST' &&
        (['/token', '/recordings/url'].includes(path) ||
          safeParticipantAction)) ||
      (method === 'DELETE' && path === '');
    const retries = safe ? 5 : 0;
    const url =
      this.config.getOrThrow<string>('CALLS_SERVICE_URL').replace(/\/$/, '') +
      '/rooms/' +
      encodeURIComponent(room) +
      path;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + this.config.getOrThrow('CALLS_SERVICE_SECRET'),
    };
    const deadline = Date.now() + 90_000;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const remaining = deadline - Date.now();
      if (safe && remaining <= 0) break;
      let response: Response | undefined;
      try {
        response = await fetch(url, {
          method,
          headers,
          ...(payload === undefined ? {} : { body: payload }),
          // Bound the entire read/token operation, not only each attempt.
          signal: AbortSignal.timeout(
            safe
              ? Math.min(10_000, remaining)
              : path === '/recordings/transcribe'
                ? 18 * 60_000
                : 30_000,
          ),
        });
        if (response.ok) {
          if (method === 'HEAD' || response.status === 204)
            return undefined as T;
          return (await response.json()) as T;
        }
      } catch {
        // Network errors, timeouts and interrupted response bodies can be retried
        // for reads. Provider bodies/URLs/credentials never enter API errors/logs.
      }
      if (response && !response.ok && !retryableStatuses.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        // 401/403 here concern service credentials, not the caller's login.
        const status =
          response.status >= 400 &&
          response.status < 500 &&
          ![401, 403].includes(response.status)
            ? response.status
            : 503;
        throw new HttpException(
          {
            code: 'UPSTREAM_REQUEST_FAILED',
            message: 'Сервис звонков не смог выполнить запрос.',
          },
          status,
        );
      }
      if (response && !response.ok)
        await response.body?.cancel().catch(() => undefined);
      if (attempt === retries) break;
      const waitMs = retryDelay(
        attempt,
        response?.headers.get('retry-after') ?? null,
      );
      if (Date.now() + waitMs >= deadline) break;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    // The client must not start another retry loop around these six attempts.
    throw new ServiceUnavailableException({
      code: safe ? 'UPSTREAM_RETRIES_EXHAUSTED' : 'UPSTREAM_REQUEST_FAILED',
      message: unavailableMessage,
    });
  }
}
