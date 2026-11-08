import 'reflect-metadata';
import { UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { PartnerController } from './partner.controller.js';
import { PartnerAdminController } from './partner-admin.controller.js';
import { PartnerAdminGuard } from './partner-admin.guard.js';
import type { PartnerService } from './partner.service.js';

vi.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));

describe('partner access boundaries', () => {
  it('requires the independent administrator guard on every private admin endpoint', () => {
    for (const endpoint of ['session', 'logout', 'credentials', 'data', 'terms', 'review', 'pay', 'adjustment', 'payment', 'refund'] as const) {
      expect(Reflect.getMetadata(GUARDS_METADATA, PartnerAdminController.prototype[endpoint])).toContain(PartnerAdminGuard);
    }
  });

  it('never turns an incomplete user identity into an unscoped administrator data query', () => {
    const partners = { getData: vi.fn() };
    const controller = new PartnerController(partners as unknown as PartnerService);
    expect(() => controller.me({ user: {} } as never)).toThrow(UnauthorizedException);
    expect(partners.getData).not.toHaveBeenCalled();
    controller.me({ user: { sub: 'authenticated-user' } } as never);
    expect(partners.getData).toHaveBeenCalledWith('authenticated-user');
  });
});
