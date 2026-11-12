import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { OAuthService, safeReturnTo } from './oauth.service.js';

const proof = (v: string) => createHash('sha256').update(v).digest('base64url');
const redisKey = (kind: string, value: string) => `oauth:${kind}:${proof(value)}`;
function setup(enabled = true) {
  const records = new Map<string, any>();
  const redis = {
    setJson: vi.fn(async (key: string, value: unknown) => { records.set(key, value); }),
    getJson: vi.fn(async (key: string) => records.get(key)),
    takeJson: vi.fn(async (key: string) => { const data = records.get(key); records.delete(key); return data; }),
    countAttempt: vi.fn(async () => 1),
    setNxEx: vi.fn(async (key: string) => { if (records.has(key)) return false; records.set(key, true); return true; }),
    delete: vi.fn(async (key: string) => { records.delete(key); }),
  };
  const prisma = { oAuthIdentity: { findUnique: vi.fn(async () => null) } };
  const auth = { buildAuthRdo: vi.fn(async (user: unknown) => ({ accessToken: 'unit-session', user })), confirmOAuthEmail: vi.fn() };
  const config = new ConfigService(enabled ? { YANDEX_ID_CLIENT_ID: 'app-id', YANDEX_ID_REDIRECT_URI: 'https://api.example.test/api/auth/oauth/yandex/callback',
    VK_ID_CLIENT_ID: 'vk-app-id', VK_ID_REDIRECT_URI: 'https://api.example.test/api/auth/oauth/vk/callback', APP_URL: 'https://example.test' } : {});
  const service = new OAuthService(config, redis as any, prisma as any, auth as any, {} as any, {} as any);
  const verifier = randomBytes(32).toString('base64url');
  return { service, records, redis, prisma, auth, verifier, dto: { codeChallenge: proof(verifier), returnTo: '/invite/sample' } };
}
afterEach(() => vi.unstubAllGlobals());
describe('OAuth login boundary', () => {
  it('only allows local return paths and keeps invitation context', () => {
    for (const value of ['https://attacker.test', '//attacker.test', '/\\attacker.test', '/\n/attacker.test']) expect(safeReturnTo(value)).toBe('/');
    expect(safeReturnTo('/invite/abc?x=1')).toBe('/invite/abc?x=1');
  });
  it('does not expose or start unconfigured providers', async () => {
    const { service, dto } = setup(false);
    expect(service.providers().every(p => !p.enabled)).toBe(true);
    await expect(service.start('yandex', dto, 'local')).rejects.toMatchObject({ status: 503 });
  });
  it('uses separate provider PKCE, validates state once and does not authenticate by email alone', async () => {
    const { service, dto, verifier, records, auth } = setup();
    const start = new URL((await service.start('yandex', dto, 'local')).authorizationUrl);
    expect(start.searchParams.get('code_challenge')).not.toBe(dto.codeChallenge);
    const state = start.searchParams.get('state')!;
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'provider-token' }))
      .mockResolvedValueOnce(Response.json({ id: '123', client_id: 'app-id', default_email: 'owner@example.test', real_name: 'Owner' }));
    vi.stubGlobal('fetch', fetcher);
    const ticket = await service.callback('yandex', { state, code: 'provider-code' });
    await expect(service.callback('yandex', { state, code: 'provider-code' })).rejects.toMatchObject({ status: 400 });
    expect(await service.exchange({ ticket, codeVerifier: verifier })).toEqual({ requiresEmail: true, email: 'owner@example.test' });
    expect(auth.buildAuthRdo).not.toHaveBeenCalled();
    expect(JSON.stringify(records.get(redisKey('ticket', ticket)))).not.toContain('provider-token');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBe('OAuth provider-token');
  });
  it('rejects a ticket opened by a different browser before reading account data', async () => {
    const { service, records, prisma, dto } = setup();
    const ticket = randomBytes(32).toString('base64url');
    records.set(redisKey('ticket', ticket), { ...dto, provider: 'yandex', subject: '123' });
    await expect(service.exchange({ ticket, codeVerifier: randomBytes(32).toString('base64url') })).rejects.toMatchObject({ status: 400 });
    expect(prisma.oAuthIdentity.findUnique).not.toHaveBeenCalled();
  });
  it('authenticates an already linked subject and consumes the ticket once', async () => {
    const { service, records, prisma, dto, verifier } = setup();
    const ticket = randomBytes(32).toString('base64url');
    records.set(redisKey('ticket', ticket), { ...dto, provider: 'yandex', subject: '123' });
    prisma.oAuthIdentity.findUnique.mockResolvedValue({ user: { id: 'linked', email: 'owner@example.test' } } as any);
    const result = await service.exchange({ ticket, codeVerifier: verifier });
    expect(result).toMatchObject({ user: { id: 'linked' }, returnTo: '/invite/sample' });
    await expect(service.exchange({ ticket, codeVerifier: verifier })).rejects.toMatchObject({ status: 400 });
  });
  it('rejects Yandex responses for another app and VK subject substitution', async () => {
    const { service, dto } = setup();
    let start = new URL((await service.start('yandex', dto, 'local')).authorizationUrl);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'provider-token' }))
      .mockResolvedValueOnce(Response.json({ id: '123', client_id: 'another-app' })));
    await expect(service.callback('yandex', { state: start.searchParams.get('state'), code: 'code' })).rejects.toMatchObject({ status: 400 });
    start = new URL((await service.start('vk', dto, 'local')).authorizationUrl);
    const state = start.searchParams.get('state');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ access_token: 'provider-token', user_id: 10, state }))
      .mockResolvedValueOnce(Response.json({ user: { user_id: 20 } })));
    await expect(service.callback('vk', { state, code: 'code', device_id: 'device' })).rejects.toMatchObject({ status: 400 });
  });
});
