import { describe, expect, it } from 'vitest';
import { accountBalance, addMonths, eventDate, kopecks, proportional } from './partner.money.js';

describe('partner financial arithmetic', () => {
  it('keeps money in exact kopecks and rejects fractions, zero, overflow and invalid numbers', () => {
    expect(kopecks(24900)).toBe(2490000);
    expect(kopecks(0.29)).toBe(29);
    expect(kopecks(-0.29, true)).toBe(-29);
    for (const value of [0, -1, 0.001, NaN, Infinity, 21474836.48]) expect(() => kopecks(value)).toThrow();
    expect(() => kopecks(0, true)).toThrow();
  });

  it('rounds commission once without floating-point multiplication loss', () => {
    expect(proportional(2490000, 2000, 10000)).toBe(498000);
    expect(proportional(1, 5000, 10000)).toBe(1);
    expect(proportional(2147483647, 10000, 10000)).toBe(2147483647);
    expect(proportional(100000, 0, 10000)).toBe(0);
  });

  it('cumulative partial refunds reverse exactly the original commission', () => {
    const commission = 3, payment = 7;
    let reversed = 0;
    for (let cumulative = 1; cumulative <= payment; cumulative++) {
      const delta = proportional(commission, cumulative, payment) - proportional(commission, cumulative - 1, payment);
      expect(delta).toBeGreaterThanOrEqual(0);
      reversed += delta;
    }
    expect(reversed).toBe(commission);
  });

  it('clamps calendar windows to the last day of short months', () => {
    expect(addMonths(new Date('2024-01-31T12:15:00Z'), 1).toISOString()).toBe('2024-02-29T12:15:00.000Z');
    expect(addMonths(new Date('2024-02-29T12:15:00Z'), 12).toISOString()).toBe('2025-02-28T12:15:00.000Z');
  });

  it('validates event dates and accepts a date-only payment on registration day', () => {
    const start = new Date('2026-11-08T12:00:00Z'), now = new Date('2026-11-08T15:00:00Z');
    expect(eventDate('2026-11-08', start, now)).toEqual(start);
    expect(eventDate(undefined, start, now)).toEqual(now);
    for (const value of ['bad', '2026-02-30', '2026-11-07', '2026-11-09', '2026-11-08T16:00:00Z']) {
      expect(() => eventDate(value, start, now)).toThrow();
    }
  });

  it('accepts the current Moscow date before UTC midnight', () => {
    const now = new Date('2026-11-08T22:00:00Z');
    const earlier = new Date('2026-11-07T12:00:00Z');
    expect(eventDate('2026-11-09', earlier, now).toISOString()).toBe('2026-11-08T21:00:00.000Z');
    const sameDay = new Date('2026-11-08T21:30:00Z');
    expect(eventDate('2026-11-09', sameDay, now)).toEqual(sameDay);
    expect(() => eventDate('2026-11-10', earlier, now)).toThrow();
    expect(() => eventDate('2026-11-08', sameDay, now)).toThrow();
  });

  it('treats Moscow day boundaries as inclusive start and exclusive end', () => {
    const midnight = new Date('2026-11-08T21:00:00Z');
    expect(eventDate('2026-11-09', midnight, midnight)).toEqual(midnight);
    expect(() => eventDate('2026-11-08', midnight, new Date('2026-11-09T10:00:00Z'))).toThrow();
    expect(() => eventDate('2026-11-09', new Date('2026-11-07'), new Date('2026-11-08T20:59:59Z'))).toThrow();
    expect(() => eventDate('2026-02-30', new Date('2026-01-01'), new Date('2026-03-01'))).toThrow();
  });

  it('keeps full timestamps strictly chronological without calendar-day clamping', () => {
    const start = new Date('2026-11-08T21:30:00Z'), now = new Date('2026-11-08T22:00:00Z');
    expect(eventDate('2026-11-09T00:45:00+03:00', start, now).toISOString()).toBe('2026-11-08T21:45:00.000Z');
    expect(() => eventDate('2026-11-09T00:00:00+03:00', start, now)).toThrow();
    expect(() => eventDate('2026-11-09T01:01:00+03:00', start, now)).toThrow();
  });

  it('excludes held funds and reserves every open payout while releasing rejected and partial remainders', () => {
    const now = new Date('2026-11-08T12:00:00Z');
    const ledger = [
      { amountKopecks: 100000, availableAt: now },
      { amountKopecks: 80000, availableAt: new Date('2026-11-09') },
    ];
    const payouts = [
      { id: 'a', status: 'new', amountKopecks: 10000, paidKopecks: null },
      { id: 'b', status: 'approved', amountKopecks: 20000, paidKopecks: null },
      { id: 'c', status: 'review', amountKopecks: 10000, paidKopecks: null },
      { id: 'd', status: 'rejected', amountKopecks: 90000, paidKopecks: null },
      { id: 'e', status: 'paid', amountKopecks: 20000, paidKopecks: 5000 },
    ];
    expect(accountBalance(ledger, payouts, now)).toEqual({ matured: 100000, pending: 80000, paid: 5000, reserved: 40000, available: 55000 });
    expect(accountBalance(ledger, payouts, now, 'b').available).toBe(75000);
  });

  it('retains negative balances after refunds instead of allowing a second withdrawal', () => {
    const now = new Date();
    const balance = accountBalance([
      { amountKopecks: 100000, availableAt: now },
      { amountKopecks: -100000, availableAt: now },
    ], [{ id: 'paid', status: 'paid', amountKopecks: 100000, paidKopecks: 100000 }], now);
    expect(balance.available).toBe(-100000);
    expect(balance.paid).toBe(100000);
  });
});
