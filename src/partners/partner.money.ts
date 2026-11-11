import { BadRequestException } from '@nestjs/common';

export const DAY = 86_400_000;
export const MAX_KOPECKS = 2_147_483_647;

export function kopecks(value: number, signed = false): number {
  const result = Math.round(value * 100);
  if (!Number.isFinite(value) || !Number.isSafeInteger(result) ||
    Math.abs(result) > MAX_KOPECKS || Math.abs(value * 100 - result) > 0.00001 ||
    (signed ? result === 0 : result <= 0)) {
    throw new BadRequestException('Укажите сумму с точностью до копейки в допустимом диапазоне.');
  }
  return result;
}

export function proportional(amount: number, numerator: number, denominator: number): number {
  return Number((BigInt(amount) * BigInt(numerator) + BigInt(Math.floor(denominator / 2))) / BigInt(denominator));
}

export function addMonths(value: Date, months: number): Date {
  const result = new Date(value);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}

export function eventDate(value: string | undefined, earliest: Date, now = new Date()): Date {
  if (!value) return now;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const calendarDate = new Date(dateOnly ? `${value}T00:00:00Z` : value);
  if (!Number.isFinite(calendarDate.getTime()) || (dateOnly && calendarDate.toISOString().slice(0, 10) !== value)) {
    throw new BadRequestException('Укажите корректную дату.');
  }
  let result = calendarDate;
  if (dateOnly) {
    // Calendar dates in the partner program use Moscow time (UTC+3), independent
    // of the server/browser timezone. A same-day event cannot predate registration.
    const dayStart = calendarDate.getTime() - 3 * 60 * 60 * 1000;
    if (dayStart + DAY <= earliest.getTime() || dayStart > now.getTime()) {
      throw new BadRequestException('Дата не должна быть раньше исходного события или позже текущего времени.');
    }
    result = new Date(Math.max(dayStart, earliest.getTime()));
  }
  if (result < earliest || result > now) {
    throw new BadRequestException('Дата не должна быть раньше исходного события или позже текущего времени.');
  }
  return result;
}

export function accountBalance(
  ledger: { amountKopecks: number; availableAt: Date }[],
  payouts: { id: string; status: string; amountKopecks: number; paidKopecks: number | null }[],
  now = new Date(),
  exceptPayoutId?: string,
) {
  const matured = ledger.reduce((sum, item) => sum + (item.availableAt <= now ? item.amountKopecks : 0), 0);
  const pending = ledger.reduce((sum, item) => sum + (item.availableAt > now ? item.amountKopecks : 0), 0);
  const paid = payouts.reduce((sum, item) => sum + (item.status === 'paid' ? item.paidKopecks ?? 0 : 0), 0);
  const reserved = payouts.reduce((sum, item) => sum + (item.id !== exceptPayoutId && ['new', 'review', 'approved'].includes(item.status) ? item.amountKopecks : 0), 0);
  return { matured, pending, paid, reserved, available: matured - paid - reserved };
}
