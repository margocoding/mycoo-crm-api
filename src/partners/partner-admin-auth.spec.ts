import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { RedisService } from '../redis/redis.service.js';
import { PartnerAdminAuthService, hashPartnerAdminPassword } from './partner-admin-auth.service.js';
import { PartnerAdminCredentialsDto, RequestPartnerPayoutDto } from './partner.dto.js';

vi.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const clientIp = '127.0.0.1';
function fixture() {
  const prisma = {
    partnerAdmin: { findUnique: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    partnerAdminSession: { findUnique: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
  };
  prisma.$transaction.mockImplementation((callback: (client: unknown) => Promise<unknown>) => callback(prisma));
  const redis = { countAttempt: vi.fn().mockResolvedValue(1) };
  const service = new PartnerAdminAuthService(prisma as unknown as PrismaService, redis as unknown as RedisService);
  return { prisma, redis, service };
}

describe('partner administrator authentication', () => {
  it('does not accept a CRM JWT, missing header, or malformed tokens as admin credentials', async () => {
    const { service, prisma } = fixture();
    for (const header of [undefined, 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature', 'Bearer 123', `Basic ${'a'.repeat(64)}`]) {
      await expect(service.authenticate(header)).rejects.toBeInstanceOf(UnauthorizedException);
    }
    expect(prisma.partnerAdminSession.findUnique).not.toHaveBeenCalled();
  });

  it('rejects expired and revoked sessions, and only looks up a digest of the bearer token', async () => {
    const { service, prisma } = fixture();
    const token = 'a'.repeat(64);
    prisma.partnerAdminSession.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ admin: { id: 'admin', login: 'owner' }, expiresAt: new Date(0) });
    await expect(service.authenticate(`Bearer ${token}`)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(service.authenticate(`Bearer ${token}`)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.partnerAdminSession.findUnique).toHaveBeenCalledWith({ where: { tokenHash: tokenHash(token) }, include: { admin: true } });
  });

  it('blocks repeated login attempts before checking passwords', async () => {
    const { service, prisma, redis } = fixture();
    redis.countAttempt.mockResolvedValue(101);
    await expect(service.login('owner', randomBytes(16).toString('hex'), clientIp)).rejects.toMatchObject({ status: 429 });
    expect(prisma.partnerAdmin.findUnique).not.toHaveBeenCalled();
  });

  it('stores a hashed session and rejects a password changed while login was in progress', async () => {
    const { service, prisma } = fixture();
    const password = randomBytes(16).toString('hex');
    const admin = { id: 'owner-id', login: 'owner', passwordHash: await hashPartnerAdminPassword(password) };
    prisma.partnerAdmin.findUnique.mockResolvedValue(admin);
    const session = await service.login(' OWNER ', password, clientIp);
    expect(session.adminId).toBe(admin.id);
    expect(session.token).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.partnerAdminSession.create).toHaveBeenCalledWith({ data: { adminId: admin.id, tokenHash: tokenHash(session.token), expiresAt: expect.any(Date) } });
    expect(prisma.partnerAdminSession.create.mock.calls[0][0].data).not.toHaveProperty('token');
    prisma.partnerAdminSession.create.mockClear();
    prisma.partnerAdmin.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.login('owner', password, clientIp)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.partnerAdminSession.create).not.toHaveBeenCalled();
  });

  it('requires the current password and revokes every prior session on credential rotation', async () => {
    const { service, prisma } = fixture();
    const oldPassword = randomBytes(16).toString('hex'), newPassword = randomBytes(16).toString('hex');
    const passwordHash = await hashPartnerAdminPassword(oldPassword);
    prisma.partnerAdmin.findUnique.mockResolvedValue({ id: 'owner-id', login: 'owner', passwordHash });
    const identity = { id: 'owner-id', login: 'owner', tokenHash: 'stored-hash' };
    await expect(service.updateCredentials(identity, { currentPassword: randomBytes(16).toString('hex'), login: 'new-owner', password: newPassword })).rejects.toBeInstanceOf(UnauthorizedException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const result = await service.updateCredentials(identity, { currentPassword: oldPassword, login: 'NEW-OWNER', password: newPassword });
    expect(result.login).toBe('new-owner');
    expect(result.adminId).toBe('owner-id');
    expect(prisma.partnerAdminSession.deleteMany).toHaveBeenCalledWith({ where: { adminId: 'owner-id' } });
    expect(prisma.partnerAdmin.updateMany).toHaveBeenCalledWith({ where: { id: 'owner-id', passwordHash }, data: { login: 'new-owner', passwordHash: expect.any(String) } });
    expect(prisma.partnerAdminSession.create).toHaveBeenCalledWith({ data: { adminId: 'owner-id', tokenHash: tokenHash(result.token), expiresAt: expect.any(Date) } });
  });
});

describe('partner request validation', () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  it('rejects a caller-supplied partner identity and invalid monetary precision', async () => {
    const transform = (value: unknown) => pipe.transform(value, { type: 'body', metatype: RequestPartnerPayoutDto });
    for (const value of [
      { amount: 1000, idempotencyKey: 'request-123', partnerId: 'another-partner' },
      { amount: 0.001, idempotencyKey: 'request-123' },
      { amount: -100, idempotencyKey: 'request-123' },
      { amount: 1000 },
    ]) await expect(transform(value)).rejects.toBeInstanceOf(BadRequestException);
    await expect(transform({ amount: 1000.25, idempotencyKey: 'request-123' })).resolves.toMatchObject({ amount: 1000.25 });
  });

  it('does not allow short replacement passwords despite inheritance from the login DTO', async () => {
    await expect(pipe.transform({ login: 'owner', password: 'short', currentPassword: randomBytes(16).toString('hex') }, { type: 'body', metatype: PartnerAdminCredentialsDto })).rejects.toBeInstanceOf(BadRequestException);
  });
});
