import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';

export interface CallRecording {
  id: string;
  status: number;
  files?: { filename: string; size: string }[];
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
      throw new ServiceUnavailableException('Сервис звонков ещё не настроен.');
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
      if (!response.ok) throw new Error('Calls service failed');
      return (await response.json()) as T;
    } catch {
      throw new ServiceUnavailableException(
        'Не удалось связаться с сервисом звонков. Повторите попытку.',
      );
    }
  }
}
