import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.service.js';
import { addPeriod, DAY } from './billing.plans.js';

function fixture(plan = 'START', period = 'YEAR') {
  const now = new Date();
  const subscription = { id: 'sub', userId: 'owner', kind: 'PAID', plan, period,
    createdAt: new Date(now.getTime() - 5 * DAY), usageAnchorAt: new Date(now.getTime() - 5 * DAY), activeUntil: new Date(now.getTime() + 15 * DAY) };
  let order: any;
  const db: any = {
    workspace: { findFirst: async () => ({ id: 'workspace', ownerId: 'owner' }) },
    subscription: { findFirst: async () => subscription, update: vi.fn(async ({ data }) => Object.assign(subscription, data)) },
    paymentOrder: { findUnique: async () => order ?? null, findUniqueOrThrow: async () => order, findFirst: async () => null,
      create: async ({ data }) => (order = { id: 'order', currency: 'RUB', ...data }), update: async ({ data }) => Object.assign(order, data) },
    referral: { findFirst: async () => null },
    user: { findUniqueOrThrow: async () => ({ pendingReferralDays: 0, trialStartedAt: now }), update: async () => ({}) },
    $executeRaw: async () => 1,
  };
  db.$transaction = (fn: any) => fn(db);
  const billing = new BillingService(db, {} as never, { available: true, isTest: true, checkout: async () => 'https://example.invalid/test' } as never,
    { creditPayment: async () => {} } as never);
  return { billing, subscription, db, order: () => order };
}

describe('Paid plan changes', () => {
  it('allows annual Start to monthly Corporation, and refuses the reverse plan downgrade', async () => {
    const f = fixture();
    await expect(f.billing.createOrder('owner', { workspaceId: 'workspace', plan: 'ENTERPRISE', period: 'MONTH', idempotencyKey: 'key' })).resolves.toHaveProperty('orderId');
    const reversed = fixture('ENTERPRISE', 'MONTH');
    await expect(reversed.billing.createOrder('owner', { workspaceId: 'workspace', plan: 'START', period: 'YEAR', idempotencyKey: 'key' })).rejects.toMatchObject({ status: 400 });
  });
  it('adds the newly paid period plus remaining value and preserves the monthly usage anchor', async () => {
    const f = fixture('START', 'MONTH');
    const anchor = f.subscription.usageAnchorAt;
    await f.billing.createOrder('owner', { workspaceId: 'workspace', plan: 'MISSION', period: 'MONTH', idempotencyKey: 'key' });
    const before = new Date();
    await f.billing.confirmVerifiedPayment('order', 'payment', f.order().amountKopecks, 'RUB');
    expect(f.subscription.activeUntil.getTime()).toBeGreaterThan(addPeriod(before, 'MONTH').getTime() + 8 * DAY);
    expect(f.subscription.usageAnchorAt).toEqual(anchor);
    const expiry = f.subscription.activeUntil;
    await f.billing.confirmVerifiedPayment('order', 'payment', f.order().amountKopecks, 'RUB');
    expect(f.subscription.activeUntil).toEqual(expiry);
    expect(f.db.subscription.update).toHaveBeenCalledTimes(1);
  });
});
