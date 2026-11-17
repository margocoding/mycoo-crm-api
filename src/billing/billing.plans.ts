import type {
  BillingPeriod,
  SubscriptionPlan,
} from '../../generated/prisma/client.js';
import { LIMITS } from '../usage/usage.policy.js';

export const TRIAL_DAYS = 10;
export const REFERRAL_DISCOUNT_PERCENT = 10;
export const DAY = 86_400_000;
// Keep stored plan IDs stable when changing their public names and positioning.
export const PLANS = [
  {
    id: 'START',
    name: 'Старт',
    outcome: 'До 5 пользователей',
    tagline: 'Для небольшой команды',
    description: 'Все функции MyCoo для команды до 5 пользователей.',
    promise: 'Задачи, встречи и AI-помощник в одном пространстве.',
    recommended: false,
    monthKopecks: 2990000,
    yearKopecks: 29900000,
    limits: LIMITS.START,
    features: [
      'Все функции MyCoo',
      '5 пользователей',
      'AI-бюджет 1 000 ₽ в месяц',
      'Распознавание 10 часов в месяц',
      '300 незавершённых задач',
      'Хранилище 5 ГБ',
    ],
  },
  {
    id: 'MISSION',
    name: 'Бизнес',
    outcome: 'До 15 пользователей',
    tagline: 'Для растущей команды',
    description: 'Все функции MyCoo для команды до 15 пользователей.',
    promise: 'Больше участников, встреч и ресурсов для AI.',
    recommended: true,
    monthKopecks: 4990000,
    yearKopecks: 49900000,
    limits: LIMITS.MISSION,
    features: [
      'Все функции MyCoo',
      '15 пользователей',
      'AI-бюджет 2 500 ₽ в месяц',
      'Распознавание 30 часов в месяц',
      '1 000 незавершённых задач',
      'Хранилище 20 ГБ',
    ],
  },
  {
    id: 'ENTERPRISE',
    name: 'Корпорация',
    outcome: 'До 30 пользователей',
    tagline: 'Для большой команды',
    description: 'Все функции MyCoo для команды до 30 пользователей.',
    promise: 'Расширенные лимиты для работы нескольких отделов.',
    recommended: false,
    monthKopecks: 9990000,
    yearKopecks: 99900000,
    limits: LIMITS.ENTERPRISE,
    features: [
      'Все функции MyCoo',
      '30 пользователей',
      'AI-бюджет 6 000 ₽ в месяц',
      'Распознавание 100 часов в месяц',
      '3 000 незавершённых задач',
      'Хранилище 100 ГБ',
    ],
  },
] as const;

export function priceFor(plan: SubscriptionPlan, period: BillingPeriod) {
  const item = PLANS.find((p) => p.id === plan)!;
  return period === 'YEAR' ? item.yearKopecks : item.monthKopecks;
}

export function addPeriod(from: Date, period: BillingPeriod) {
  const result = new Date(from);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + (period === 'YEAR' ? 12 : 1));
  const last = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result;
}
