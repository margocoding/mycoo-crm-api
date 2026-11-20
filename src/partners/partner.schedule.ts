import { BadRequestException } from '@nestjs/common';
import type { PartnerPayoutFrequency } from '../../generated/prisma/client.js';
import { addMonths, DAY } from './partner.money.js';

const calendar = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });

export function parsePayoutDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value)
    throw new BadRequestException('Укажите корректную первую дату выплаты.');
  return date;
}

// Calendar dates are shared by every partner and include the whole payout day in Moscow.
export function nextPayoutDate(anchor: Date | null, frequency: PartnerPayoutFrequency, now = new Date()): string | null {
  if (!anchor) return null;
  const today = parsePayoutDate(calendar.format(now));
  if (anchor >= today) return anchor.toISOString().slice(0, 10);
  if (frequency === 'WEEKLY') {
    const periods = Math.ceil((today.getTime() - anchor.getTime()) / (7 * DAY));
    return new Date(anchor.getTime() + periods * 7 * DAY).toISOString().slice(0, 10);
  }
  const step = { MONTHLY: 1, QUARTERLY: 3, YEARLY: 12 }[frequency];
  const elapsed = (today.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + today.getUTCMonth() - anchor.getUTCMonth();
  const periods = Math.max(0, Math.floor(elapsed / step));
  let next = addMonths(anchor, periods * step);
  if (next < today) next = addMonths(anchor, (periods + 1) * step);
  return next.toISOString().slice(0, 10);
}
