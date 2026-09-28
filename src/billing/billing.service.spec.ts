import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service.js';
import { PaymentGateway } from './payment.gateway.js';
import { addPeriod, DAY, PLANS, priceFor } from './billing.plans.js';

afterEach(() => vi.useRealTimers());

describe('Subscription dates and pricing', () => {
  it('clamps monthly periods at the end of a short month', () => {
    expect(addPeriod(new Date('2027-01-31T12:30:00Z'), 'MONTH').toISOString()).toBe('2027-02-28T12:30:00.000Z');
  });
  it('handles leap years and annual periods without mutating the source date', () => {
    const date = new Date('2028-02-29T12:30:00Z');
    expect(addPeriod(date, 'YEAR').toISOString()).toBe('2029-02-28T12:30:00.000Z');
    expect(date.getUTCDate()).toBe(29);
  });
  it('charges the approved monthly prices and ten months for an annual subscription', () => {
    expect(PLANS.map(p => priceFor(p.id, 'MONTH'))).toEqual([2990000, 4990000, 9990000]);
    expect(PLANS.map(p => priceFor(p.id, 'YEAR'))).toEqual([29900000, 49900000, 99900000]);
    for (const plan of PLANS) expect(priceFor(plan.id, 'YEAR')).toBe(priceFor(plan.id, 'MONTH') * 10);
  });
});

function fixture(current: any = null) {
  const db: any = { $executeRaw: vi.fn(),
    user: { findUnique: vi.fn(async () => ({ id: 'inviter' })), update: vi.fn() },
    referral: { createMany: vi.fn(async () => ({ count: 1 })) },
    subscription: { findFirst: vi.fn(async () => current), update: vi.fn() },
    workspace: { findFirst: vi.fn(async () => ({ ownerId: 'inviter' })) },
  };
  return { db, billing: new BillingService(db, new ConfigService(), new PaymentGateway()) };
}

describe('Referral credits and access', () => {
  it('ignores duplicate attribution without granting days again', async () => {
    const { db, billing } = fixture();
    db.referral.createMany.mockResolvedValue({ count: 0 });
    await billing.creditReferral(db, 'new-user', 'referral-code');
    expect(db.subscription.update).not.toHaveBeenCalled();
    expect(db.user.update).not.toHaveBeenCalled();
  });
  it('rejects self-referrals and ignores unknown referral codes', async () => {
    const { db, billing } = fixture();
    await billing.creditReferral(db, 'inviter', 'referral-code');
    db.user.findUnique.mockResolvedValue(null);
    await billing.creditReferral(db, 'other', 'unknown-code');
    expect(db.referral.createMany).not.toHaveBeenCalled();
  });
  it('saves the bonus until the inviter starts their first trial', async () => {
    const { db, billing } = fixture();
    await billing.creditReferral(db, 'new-user', 'referral-code');
    expect(db.user.update).toHaveBeenCalledWith({ where: { id: 'inviter' }, data: { pendingReferralDays: { increment: 30 } } });
  });
  it.each([[-5, 30], [5, 35]])('extends from max(now, expiry): %i days remaining', async (remaining, expected) => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T10:00:00Z'));
    const { db, billing } = fixture({ id: 'subscription', activeUntil: new Date(Date.now() + remaining * DAY) });
    await billing.creditReferral(db, 'new-user', 'referral-code');
    expect(db.subscription.update.mock.calls[0][0].data.activeUntil.getTime()).toBe(Date.now() + expected * DAY);
  });
  it('denies access at the exact expiry and checks the workspace owner, not a member subscription', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T10:00:00Z'));
    const { db, billing } = fixture({ kind: 'TRIAL', activeUntil: new Date() });
    await expect(billing.assertWorkspaceAccess('member', 'workspace')).rejects.toMatchObject({ status: 402 });
    expect(db.subscription.findFirst.mock.calls[0][0].where).toEqual({ userId: 'inviter' });
  });
  it('does not enable payments or subscriptions when the gateway is unavailable', async () => {
    const { db, billing } = fixture();
    await expect(billing.createOrder('user', { plan: 'MISSION', period: 'MONTH', idempotencyKey: 'key' })).rejects.toMatchObject({ status: 503 });
    expect(db.subscription.update).not.toHaveBeenCalled();
  });
});
