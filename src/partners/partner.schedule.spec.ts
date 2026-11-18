import { describe, expect, it } from 'vitest';
import { nextPayoutDate, parsePayoutDate } from './partner.schedule.js';

describe('shared partner payout calendar', () => {
  it('leaves dates unset until the administrator configures the schedule', () => {
    expect(nextPayoutDate(null, 'MONTHLY')).toBeNull();
  });

  it('starts on the selected date, independent of partner registration or requests', () => {
    for (const frequency of ['WEEKLY', 'MONTHLY', 'QUARTERLY', 'YEARLY'] as const)
      expect(nextPayoutDate(parsePayoutDate('2026-11-20'), frequency, new Date('2026-11-18T12:00:00Z'))).toBe('2026-11-20');
  });

  it('keeps the whole Moscow payout day available and advances after midnight', () => {
    const anchor = parsePayoutDate('2026-11-20');
    expect(nextPayoutDate(anchor, 'WEEKLY', new Date('2026-11-19T21:00:00Z'))).toBe('2026-11-20');
    expect(nextPayoutDate(anchor, 'WEEKLY', new Date('2026-11-20T20:59:59Z'))).toBe('2026-11-20');
    expect(nextPayoutDate(anchor, 'WEEKLY', new Date('2026-11-20T21:00:00Z'))).toBe('2026-11-27');
  });

  it('clamps short months without moving the original day in subsequent months', () => {
    const anchor = parsePayoutDate('2026-01-31');
    expect(nextPayoutDate(anchor, 'MONTHLY', new Date('2026-02-01T12:00:00Z'))).toBe('2026-02-28');
    expect(nextPayoutDate(anchor, 'MONTHLY', new Date('2026-03-01T12:00:00Z'))).toBe('2026-03-31');
    expect(nextPayoutDate(anchor, 'QUARTERLY', new Date('2026-04-01T12:00:00Z'))).toBe('2026-04-30');
    expect(nextPayoutDate(anchor, 'QUARTERLY', new Date('2026-05-01T12:00:00Z'))).toBe('2026-07-31');
  });

  it('restores February 29 in leap years and advances across year boundaries', () => {
    const anchor = parsePayoutDate('2024-02-29');
    expect(nextPayoutDate(anchor, 'YEARLY', new Date('2025-01-01T12:00:00Z'))).toBe('2025-02-28');
    expect(nextPayoutDate(anchor, 'YEARLY', new Date('2028-01-01T12:00:00Z'))).toBe('2028-02-29');
    expect(nextPayoutDate(parsePayoutDate('2026-11-20'), 'MONTHLY', new Date('2026-12-21T12:00:00Z'))).toBe('2027-01-20');
  });

  it('rejects invalid calendar dates and timestamps supplied instead of a date', () => {
    for (const value of ['', '2026-02-30', '2026-13-01', '2026-2-01', '2026-11-20T12:00:00Z', 'not-a-date'])
      expect(() => parsePayoutDate(value)).toThrow();
    expect(parsePayoutDate('2028-02-29').toISOString()).toBe('2028-02-29T00:00:00.000Z');
  });
});
