import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

export interface CallRecording {
  id: string;
  status: number;
  files?: { filename: string; size: string }[];
}
export type CallsFailure =
  | 'configuration'
  | 'authentication'
  | 'storage'
  | 'livekit'
  | 'timeout'
  | 'network'
  | 'response';

export class CallsRequestError extends ServiceUnavailableException {
  constructor(
    readonly reason: CallsFailure,
    readonly upstreamStatus?: number,
  ) {
    super('Не удалось связаться с сервисом звонков. Повторите попытку.');
  }
}

@Injectable()
export class CallsClient {
  private readonly logger = new Logger(CallsClient.name);
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
    if (!this.configured) throw new CallsRequestError('configuration');
    try {
      const response = await fetch(
        this.config.getOrThrow<string>('CALLS_SERVICE_URL').replace(/\/$/, '') +
          '/rooms/' +
          encodeURIComponent(room) +
          path,
        {
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization:
              'Bearer ' + this.config.getOrThrow('CALLS_SERVICE_SECRET'),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(
            path === '/recordings/transcribe' ? 18 * 60_000 : 30_000,
          ),
        },
      );
      if (!response.ok) {
        // Only classify known responses. Never copy upstream bodies, URLs or
        // credentials into browser responses or logs.
        const payload = (await response.json().catch(() => null)) as {
          message?: unknown;
        } | null;
        const reason: CallsFailure = [401, 403].includes(response.status)
          ? 'authentication'
          : payload?.message === 'Recording storage is not configured'
            ? 'storage'
            : payload?.message === 'LiveKit is not configured'
              ? 'livekit'
              : 'response';
        throw new CallsRequestError(reason, response.status);
      }
      return (await response.json()) as T;
    } catch (e) {
      const failure =
        e instanceof CallsRequestError
          ? e
          : new CallsRequestError(
              e instanceof Error &&
                ['TimeoutError', 'AbortError'].includes(e.name)
                ? 'timeout'
                : 'network',
            );
      this.logger.warn({
        event: 'calls_request_failed',
        room,
        operation: path || '/room',
        method,
        reason: failure.reason,
        httpStatus: failure.upstreamStatus,
      });
      throw failure;
    }
  }
}
