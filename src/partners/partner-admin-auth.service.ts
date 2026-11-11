import { ConflictException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service.js';
import { RedisService } from '../redis/redis.service.js';

export const PARTNER_ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const preparePartnerAdminPassword = (password: string) => createHash('sha256').update(password).digest('base64');
export const hashPartnerAdminPassword = (password: string) => bcrypt.hash(preparePartnerAdminPassword(password), 12);

export interface PartnerAdminIdentity { id: string; login: string; tokenHash: string }

@Injectable()
export class PartnerAdminAuthService {
  constructor(private readonly prisma: PrismaService, private readonly redis: RedisService) {}

  private async limit(key: string, maximum: number) {
    if (await this.redis.countAttempt(`partner-admin:${key}`, 15 * 60) > maximum) {
      throw new HttpException('Слишком много попыток. Повторите через 15 минут.', HttpStatus.TOO_MANY_REQUESTS);
    }
  }

  async login(login: string, password: string, ip: string) {
    const normalized = login.trim().toLowerCase();
    await this.limit(`login-ip:${hash(ip)}`, 100);
    await this.limit(`login:${hash(normalized)}`, 10);
    const admin = await this.prisma.partnerAdmin.findUnique({ where: { login: normalized } });
    // An unknown login still takes a password hash, avoiding an immediate account-existence signal.
    const passwordValid = admin
      ? await bcrypt.compare(preparePartnerAdminPassword(password), admin.passwordHash)
      : (await hashPartnerAdminPassword(password), false);
    if (!admin || !passwordValid) throw new UnauthorizedException('Неверный логин или пароль.');
    const token = randomBytes(32).toString('hex');
    await this.prisma.$transaction(async tx => {
      // Lock also serializes login with credential rotation, so old passwords cannot issue a session afterwards.
      const locked = await tx.partnerAdmin.updateMany({ where: { id: admin.id, passwordHash: admin.passwordHash }, data: { updatedAt: new Date() } });
      if (!locked.count) throw new UnauthorizedException('Данные для входа изменились. Войдите снова.');
      await tx.partnerAdminSession.deleteMany({ where: { expiresAt: { lte: new Date() } } });
      await tx.partnerAdminSession.create({ data: { adminId: admin.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + PARTNER_ADMIN_SESSION_MS) } });
    });
    return { token, login: admin.login, adminId: admin.id };
  }

  async authenticate(header?: string): Promise<PartnerAdminIdentity> {
    const match = /^Bearer ([a-f0-9]{64})$/.exec(header ?? '');
    if (!match) throw new UnauthorizedException('Войдите в кабинет администратора.');
    const tokenHash = hash(match[1]);
    const session = await this.prisma.partnerAdminSession.findUnique({ where: { tokenHash }, include: { admin: true } });
    if (!session || session.expiresAt.getTime() <= Date.now()) throw new UnauthorizedException('Сессия истекла. Войдите снова.');
    return { id: session.admin.id, login: session.admin.login, tokenHash };
  }

  async logout(identity: PartnerAdminIdentity) {
    await this.prisma.partnerAdminSession.deleteMany({ where: { tokenHash: identity.tokenHash } });
    return { ok: true };
  }

  async updateCredentials(identity: PartnerAdminIdentity, input: { currentPassword: string; login: string; password: string }) {
    await this.limit(`credentials:${identity.id}`, 10);
    const admin = await this.prisma.partnerAdmin.findUnique({ where: { id: identity.id } });
    if (!admin || !await bcrypt.compare(preparePartnerAdminPassword(input.currentPassword), admin.passwordHash)) {
      throw new UnauthorizedException('Текущий пароль указан неверно.');
    }
    const login = input.login.trim().toLowerCase();
    const passwordHash = await hashPartnerAdminPassword(input.password);
    const token = randomBytes(32).toString('hex');
    try {
      await this.prisma.$transaction(async tx => {
        const changed = await tx.partnerAdmin.updateMany({ where: { id: admin.id, passwordHash: admin.passwordHash }, data: { login, passwordHash } });
        if (!changed.count) throw new UnauthorizedException('Данные для входа изменились. Войдите снова.');
        await tx.partnerAdminSession.deleteMany({ where: { adminId: admin.id } });
        await tx.partnerAdminSession.create({ data: { adminId: admin.id, tokenHash: hash(token), expiresAt: new Date(Date.now() + PARTNER_ADMIN_SESSION_MS) } });
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw new ConflictException('Этот логин уже используется.');
      throw error;
    }
    return { token, login, adminId: admin.id };
  }
}
