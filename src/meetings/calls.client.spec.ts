import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CallsClient } from './calls.client.js';

const make = () =>
  new CallsClient(
    new ConfigService({
      CALLS_SERVICE_URL: 'http://calls.test',
      CALLS_SERVICE_SECRET: 'unit-test-placeholder-not-a-real-secret',
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('Calls diagnostics', () => {
  it('retains the operation and HTTP status without exposing upstream secrets', async () => {
    const log = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              message: 'Bearer private-token, password=private-value',
            }),
            { status: 500 },
          ),
      ),
    );
    await expect(
      make().request('test-room', '/recordings', 'POST'),
    ).rejects.toMatchObject({ reason: 'response', upstreamStatus: 500 });
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: '/recordings',
        method: 'POST',
        httpStatus: 500,
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toMatch(
      /private-token|private-value|unit-test-placeholder/,
    );
  });
  it('identifies a missing storage configuration from an allowlisted response', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ message: 'Recording storage is not configured' }),
            { status: 503 },
          ),
      ),
    );
    await expect(
      make().request('test-room', '/recordings', 'POST'),
    ).rejects.toMatchObject({ reason: 'storage', upstreamStatus: 503 });
  });
  it('distinguishes a timeout from an authentication failure', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('test', 'TimeoutError');
      }),
    );
    await expect(
      make().request('test-room', '/recordings'),
    ).rejects.toMatchObject({ reason: 'timeout' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 401 })),
    );
    await expect(
      make().request('test-room', '/recordings'),
    ).rejects.toMatchObject({ reason: 'authentication', upstreamStatus: 401 });
  });
});
