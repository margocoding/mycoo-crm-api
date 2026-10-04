import type {
  BillingPeriod,
  SubscriptionPlan,
} from '../../generated/prisma/client.js';

export const TRIAL_DAYS = 10;
export const REFERRAL_DISCOUNT_PERCENT = 10;
export const DAY = 86_400_000;
// Keep stored plan IDs stable when changing their public names and positioning.
export const PLANS = [
  {
    id: 'START',
    name: 'Старт',
    outcome: 'Видеть',
    tagline: 'Наведите порядок',
    description: 'Я хочу перестать держать всё в голове.',
    promise: 'Я понимаю, что происходит в моём бизнесе.',
    recommended: false,
    monthKopecks: 2990000,
    yearKopecks: 29900000,
    features: [
      'Единое пространство бизнеса',
      'Дашборд собственника',
      'AI-ассистент собственника',
      'Контроль исполнения',
      'Цели и приоритеты',
      'База знаний компании',
    ],
  },
  {
    id: 'MISSION',
    name: 'Контроль',
    outcome: 'Управлять',
    tagline: 'Сделайте бизнес управляемым',
    description:
      'Я хочу, чтобы команда работала по системе, а отклонения становились видны до того, как превращаются в проблемы.',
    promise: 'Я вижу отклонения и управляю исполнением.',
    recommended: true,
    monthKopecks: 4990000,
    yearKopecks: 49900000,
    features: [
      'Всё из тарифа «Старт»',
      'Управленческий дашборд',
      'AI-анализ бизнеса',
      'Встречи и автоматические протоколы',
      'Еженедельный отчёт собственнику',
      'Контроль руководителей',
      'AI-рекомендации',
    ],
  },
  {
    id: 'ENTERPRISE',
    name: 'Опердир',
    outcome: 'Освободиться',
    tagline: 'Передайте MyCOO операционный контур',
    description:
      'Я хочу выйти из операционки и оставить за собой стратегические решения.',
    promise: 'MyCOO держит операционный контур, а я занимаюсь бизнесом.',
    recommended: false,
    monthKopecks: 9990000,
    yearKopecks: 99900000,
    features: [
      'Всё из тарифа «Контроль»',
      'Ежедневная сводка собственнику',
      'AI-радар рисков',
      'Центр принятия решений',
      'AI-подготовка управленческих встреч',
      'Автоматический управленческий отчёт',
      'Накопление знаний и контекста компании',
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
