import type { SubscriptionPlan } from '../../generated/prisma/client.js';

export const RUB = 1_000_000;
export const GB = 1_000_000_000;
export const LIMITS = {
  TRIAL: { users: 5, tasks: 300, storageBytes: 5 * GB, budgetRub: 150, audioSeconds: 3 * 3600, inputTokens: 500_000, outputTokens: 200_000 },
  START: { users: 5, tasks: 300, storageBytes: 5 * GB, budgetRub: 1000, audioSeconds: 10 * 3600, inputTokens: null, outputTokens: null },
  MISSION: { users: 15, tasks: 1000, storageBytes: 20 * GB, budgetRub: 2500, audioSeconds: 30 * 3600, inputTokens: null, outputTokens: null },
  ENTERPRISE: { users: 30, tasks: 3000, storageBytes: 100 * GB, budgetRub: 6000, audioSeconds: 100 * 3600, inputTokens: null, outputTokens: null },
} as const;

export type UsagePlan = SubscriptionPlan | 'TRIAL';
export type UsageScope = { workspaceId: string; departmentId?: string | null; actorId?: string | null; source: string; allowBeforeTrial?: boolean };
export type UsageAmount = { costMicros: number; inputTokens: number; outputTokens: number; audioSeconds: number };
export const zeroUsage = (): UsageAmount => ({ costMicros: 0, inputTokens: 0, outputTokens: 0, audioSeconds: 0 });

export function monthAt(anchor: Date, offset: number) {
  const result = new Date(anchor);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + offset);
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(anchor.getUTCDate(), last));
  return result;
}

export function usageMonth(anchor: Date, now = new Date()) {
  let offset = Math.max(0, (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + now.getUTCMonth() - anchor.getUTCMonth());
  if (monthAt(anchor, offset) > now) offset = Math.max(0, offset - 1);
  return { start: monthAt(anchor, offset), end: monthAt(anchor, offset + 1) };
}

// Default synchronous provider rates, RUB per million tokens. Deployment can
// override each model; unknown models must be configured rather than priced free.
export const GIGACHAT_RATES: Record<string, { input: number; output: number }> = {
  GigaChat: { input: 65, output: 65 }, 'GigaChat-2': { input: 65, output: 65 },
  'GigaChat-Pro': { input: 500, output: 500 }, 'GigaChat-2-Pro': { input: 500, output: 500 },
  'GigaChat-Max': { input: 650, output: 650 }, 'GigaChat-2-Max': { input: 650, output: 650 },
};

export function llmUsage(body: unknown, rates: { input: number; output: number }): UsageAmount | null {
  const usage = (body as { usage?: { prompt_tokens?: number; completion_tokens?: number; precached_prompt_tokens?: number } })?.usage;
  if (!usage) return null;
  const input = usage.prompt_tokens, output = usage.completion_tokens, cached = usage.precached_prompt_tokens ?? 0;
  if (![input, output, cached].every(n => Number.isSafeInteger(n) && n! >= 0)) return null;
  // GigaChat prompt_tokens already excludes its free cached tokens.
  return { inputTokens: input! + cached, outputTokens: output!, audioSeconds: 0,
    costMicros: Math.ceil(input! * rates.input + output! * rates.output) };
}
