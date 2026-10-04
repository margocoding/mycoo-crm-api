import { describe, expect, it } from 'vitest';
import { nextRecurrence, recurrenceDate, scheduleRecurrence } from './task-recurrence.js';

describe('Weekly task calendar (Moscow)', () => {
  it('creates Monday at Moscow midnight, even though UTC is still Sunday', () => {
    const next = nextRecurrence([1], '2026-10-04')!;
    expect(next.toISOString()).toBe('2026-10-04T21:00:00.000Z');
    expect(recurrenceDate(next)).toBe('2026-10-05');
  });
  it('advances past the current occurrence and supports several weekdays', () => {
    expect(recurrenceDate(nextRecurrence([1], '2026-10-05')!)).toBe('2026-10-12');
    expect(recurrenceDate(nextRecurrence([5, 1, 3], '2026-10-05')!)).toBe('2026-10-07');
  });
  it('crosses month/year boundaries and handles Sunday', () => {
    expect(recurrenceDate(nextRecurrence([1], '2026-12-31')!)).toBe('2027-01-04');
    expect(recurrenceDate(nextRecurrence([7], '2026-10-31')!)).toBe('2026-11-01');
  });
  it('does not backfill history when enabling a repeat and respects a future start', () => {
    const now = new Date('2026-10-04T21:30:00Z');
    expect(recurrenceDate(scheduleRecurrence([1], '2026-09-01', now)!)).toBe('2026-10-12');
    expect(recurrenceDate(scheduleRecurrence([1], '2026-11-02', now)!)).toBe('2026-11-09');
  });
  it('clears the cursor when disabled', () => {
    expect(nextRecurrence([], '2026-10-05')).toBeNull();
  });
});
