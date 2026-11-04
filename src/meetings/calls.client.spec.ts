import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallsClient } from './calls.client.js';

const secret = 'test-calls-service-secret-at-least-32-characters';
const config = {
  CALLS_SERVICE_URL: 'https://calls.test/',
  CALLS_SERVICE_SECRET: secret,
};
const client = () => new CallsClient(new ConfigService(config));
const json = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

describe('CallsClient resilience', () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-04T09:00:00Z'));
    vi.spyOn(Math, 'random').mockReturnValue(0);
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each([408, 429, 500, 502, 503, 504])(
    'makes five retries for HTTP %s, with bounded backoff',
    async (status) => {
      fetchMock.mockImplementation(async () => json({ secret }, status));
      const started = Date.now();
      const result = client()
        .request('meeting_test', '/participants')
        .catch((e: HttpException) => e);
      await vi.runAllTimersAsync();
      const error = (await result) as HttpException;
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(Date.now() - started).toBe(7750);
      expect(error.getStatus()).toBe(503);
      expect(error.getResponse()).toEqual({
        code: 'UPSTREAM_RETRIES_EXHAUSTED',
        message: 'Не удалось связаться с сервисом звонков. Повторите попытку.',
      });
      expect(JSON.stringify(error)).not.toContain(secret);
    },
  );

  it('recovers from a network failure on the sixth attempt', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    for (let i = 0; i < 5; i++)
      fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    fetchMock.mockResolvedValueOnce(json({ ok: true }));
    const result = client().request('meeting_test', '/participants');
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([400, 401, 403, 404, 409, 410, 422])(
    'does not retry permanent HTTP %s or expose its body',
    async (status) => {
      fetchMock.mockResolvedValue(json({ message: secret }, status));
      const error = (await client()
        .request('meeting_test', '/participants')
        .catch((e: HttpException) => e)) as HttpException;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error.getStatus()).toBe(
        [401, 403].includes(status) ? 503 : status,
      );
      expect(error.getResponse()).toEqual({
        code: 'UPSTREAM_REQUEST_FAILED',
        message: 'Сервис звонков не смог выполнить запрос.',
      });
    },
  );

  it.each(['/token', '/recordings/url'])(
    'retries safe POST %s with an identical body',
    async (path) => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(json({ token: 'token', url: 'url' }));
      const body =
        path === '/token'
          ? { identity: 'guest_fixed-uuid', name: 'Guest', screenShare: false }
          : { key: 'meetings/meeting_test/recording.mp4' };
      const result = client().request('meeting_test', path, 'POST', body);
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual({ token: 'token', url: 'url' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([, options]) => options?.body)).toEqual([
        JSON.stringify(body),
        JSON.stringify(body),
      ]);
    },
  );

  it.each([
    '/recordings',
    '/recordings/stop',
    '/recordings/transcribe',
    '/participant',
  ])('never automatically replays a POST mutation %s', async (path) => {
    fetchMock.mockResolvedValue(json({}, 503));
    await expect(
      client().request('meeting_test', path, 'POST', {}),
    ).rejects.toMatchObject({
      response: { code: 'UPSTREAM_REQUEST_FAILED' },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['remove', 'mute'])(
    'retries idempotent participant action %s with the same identity and settings',
    async (action) => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(json({ ok: true }));
      const body = { identity: 'guest_fixed-uuid', action, screenShare: false };
      const result = client().request(
        'meeting_test',
        '/participant',
        'POST',
        body,
      );
      await vi.runAllTimersAsync();
      await expect(result).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls.map(([, options]) => options?.body)).toEqual([
        JSON.stringify(body),
        JSON.stringify(body),
      ]);
    },
  );

  it.each(['remove', 'mute'])(
    'stops retrying participant action %s after five retries',
    async (action) => {
      fetchMock.mockImplementation(async () => json({}, 503));
      const result = client()
        .request('meeting_test', '/participant', 'POST', {
          identity: 'guest_fixed-uuid',
          action,
          screenShare: false,
        })
        .catch((e: HttpException) => e);
      await vi.runAllTimersAsync();
      expect(((await result) as HttpException).getResponse()).toMatchObject({
        code: 'UPSTREAM_RETRIES_EXHAUSTED',
      });
      expect(fetchMock).toHaveBeenCalledTimes(6);
    },
  );

  it('does not replay permissions that could override a newer revocation', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      client().request('meeting_test', '/participant', 'POST', {
        identity: 'guest_fixed-uuid',
        action: 'permissions',
        screenShare: true,
      }),
    ).rejects.toMatchObject({ response: { code: 'UPSTREAM_REQUEST_FAILED' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a room deletion after losing its response, then stops on success', async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json({ ok: true }));
    const result = client().request('meeting_test', '', 'DELETE');
    await vi.runAllTimersAsync();
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops retrying a room deletion after five retries', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    const result = client()
      .request('meeting_test', '', 'DELETE')
      .catch((e: HttpException) => e);
    await vi.runAllTimersAsync();
    expect(((await result) as HttpException).getResponse()).toMatchObject({
      code: 'UPSTREAM_RETRIES_EXHAUSTED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('does not replay an arbitrary DELETE operation', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      client().request('meeting_test', '/recordings/id', 'DELETE'),
    ).rejects.toBeInstanceOf(HttpException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['300', 'Wed, 04 Nov 2026 10:00:00 GMT'])(
    'caps Retry-After %s at eight seconds per retry',
    async (retryAfter) => {
      fetchMock.mockImplementation(async () =>
        json({}, 429, { 'retry-after': retryAfter }),
      );
      const started = Date.now();
      const result = client()
        .request('meeting_test', '/participants')
        .catch(() => undefined);
      await vi.runAllTimersAsync();
      await result;
      expect(fetchMock).toHaveBeenCalledTimes(6);
      expect(Date.now() - started).toBe(40_000);
    },
  );

  it('aborts stalled attempts at ten seconds and tries five more times', async () => {
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
        ms,
      );
      return controller.signal;
    });
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener(
            'abort',
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const started = Date.now();
    const result = client()
      .request('meeting_test', '/participants')
      .catch((e: HttpException) => e);
    await vi.runAllTimersAsync();
    expect(await result).toBeInstanceOf(HttpException);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(AbortSignal.timeout).toHaveBeenCalledWith(10_000);
    expect(Date.now() - started).toBe(67_750);
  });

  it('does not schedule another attempt beyond the total 90-second deadline', async () => {
    fetchMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve(json({}, 429, { 'retry-after': '300' })),
            10_000,
          );
        }),
    );
    const started = Date.now();
    const result = client()
      .request('meeting_test', '/participants')
      .catch((e: HttpException) => e);
    await vi.runAllTimersAsync();
    expect(((await result) as HttpException).getResponse()).toMatchObject({
      code: 'UPSTREAM_RETRIES_EXHAUSTED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(Date.now() - started).toBe(82_000);
  });

  it('keeps the transcription timeout and does not retry a timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    fetchMock.mockRejectedValue(new DOMException('Timeout', 'TimeoutError'));
    await expect(
      client().request('meeting_test', '/recordings/transcribe', 'POST', {}),
    ).rejects.toBeInstanceOf(HttpException);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(18 * 60_000);
  });
});
