import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthService } from './auth.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';
import type { MailService } from '../mail/mail.service.js';
import { describe, expect, it, vi, afterEach } from 'vitest';

function setup() {
  const records = new Map<string, unknown>();
  const users = new Map<string, any>();
  const prisma = {
    user: {
      findUnique: vi.fn(
        async ({ where }: any) => users.get(where.email) ?? null,
      ),
      create: vi.fn(async ({ data }: any) => {
        const user = { ...data, id: 'test-user', createdAt: new Date() };
        users.set(data.email, user);
        return user;
      }),
    },
  };
  const redis = {
    getJson: vi.fn(async (key: string) => records.get(key) ?? null),
    setJson: vi.fn(async (key: string, value: unknown) => {
      records.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      records.delete(key);
    }),
    ttl: vi.fn(async () => 200),
    setNxEx: vi.fn(async () => true),
    incrementCodeAttempts: vi.fn(async (key: string, purpose: string, codeHash: string) => {
      const record = records.get(key) as any;
      if (!record || record.purpose !== purpose || record.codeHash !== codeHash) return null;
      const attempts = record.attempts + 1;
      records.set(key, { ...record, attempts });
      return attempts;
    }),
  };
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  const service = new AuthService(
    prisma as unknown as PrismaService,
    redis as unknown as RedisService,
    { sendConfirmationCode: vi.fn() } as unknown as MailService,
    new JwtService({ secret: 'unit-test-secret' }),
    new ConfigService({ NODE_ENV: 'development', BCRYPT_SALT_ROUNDS: 4 }),
  );
  return { service, prisma, redis, records };
}
afterEach(() => vi.restoreAllMocks());
const email = 'test@example.test';

describe('Email confirmation before password', () => {
  it('rejects a wrong code before creating a user', async () => {
    const { service, prisma } = setup();
    await service.checkEmail({ email });
    await expect(service.verifyCode({ email, code: '000000' })).rejects.toThrow(
      'Код не совпадает',
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
  it('keeps a verified code for the final request, which revalidates and consumes it', async () => {
    const { service } = setup();
    await service.checkEmail({ email });
    await expect(
      service.verifyCode({ email, code: '111111' }),
    ).resolves.toEqual({ success: true });
    await expect(
      service.register({ email, code: '000000', password: 'TestPassword1' }),
    ).rejects.toThrow();
    const result = await service.register({
      email,
      code: '111111',
      password: 'TestPassword1',
    });
    expect(result.user.email).toBe(email);
    expect(result.accessToken).toBeTruthy();
    await expect(service.verifyCode({ email, code: '111111' })).rejects.toThrow(
      'Код не найден',
    );
  });
  it('rejects an expired code', async () => {
    const { service, records } = setup();
    await service.checkEmail({ email });
    records.clear();
    await expect(service.verifyCode({ email, code: '111111' })).rejects.toThrow(
      'Код не найден',
    );
  });
  it('blocks the code after five unsuccessful attempts', async () => {
    const { service } = setup();
    await service.checkEmail({ email });
    for (let i = 0; i < 4; i++)
      await expect(
        service.verifyCode({ email, code: '000000' }),
      ).rejects.toThrow('Код не совпадает');
    await expect(service.verifyCode({ email, code: '000000' })).rejects.toThrow(
      'Слишком много попыток',
    );
    await expect(service.verifyCode({ email, code: '111111' })).rejects.toThrow(
      'Слишком много попыток',
    );
  });
  it('enforces resend cooldown', async () => {
    const { service, redis } = setup();
    redis.setNxEx.mockResolvedValue(false);
    await expect(service.resendCode({ email })).rejects.toThrow(
      'Код уже отправлен',
    );
  });

  it('counts concurrent incorrect codes without losing attempts', async () => {
    const { service } = setup();
    await service.checkEmail({ email });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => service.verifyCode({ email, code: '000000' })));
    expect(results.every((result) => result.status === 'rejected')).toBe(true);
    await expect(service.verifyCode({ email, code: '111111' })).rejects.toThrow('Слишком много попыток');
  });

  it('does not recreate or update an expired or replaced code after comparison', async () => {
    const { service, redis } = setup();
    await service.checkEmail({ email });
    redis.incrementCodeAttempts.mockResolvedValue(null);
    await expect(service.verifyCode({ email, code: '000000' })).rejects.toThrow('Код не найден или истёк');
    expect(redis.setJson).toHaveBeenCalledTimes(1);
  });

  it('also limits wrong passwords after a valid code', async () => {
    const { service } = setup();
    await service.checkEmail({ email });
    await service.register({ email, code: '111111', password: 'CorrectPassword1' });
    await service.checkEmail({ email });
    for (let i = 0; i < 4; i++)
      await expect(service.login({ email, code: '111111', password: 'WrongPassword1' })).rejects.toThrow('Неверный email, пароль или код');
    await expect(service.login({ email, code: '111111', password: 'WrongPassword1' })).rejects.toThrow('Слишком много попыток');
    await expect(service.login({ email, code: '111111', password: 'CorrectPassword1' })).rejects.toThrow('Слишком много попыток');
  });
});
