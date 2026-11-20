import { describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { LIMITS, llmUsage, usageMonth } from './usage.policy.js';
import { UsageService } from './usage.service.js';

describe('Usage accounting policy', () => {
  it('keeps monthly anniversaries on short months without drifting from the original day', () => {
    const anchor = new Date('2024-01-31T12:15:00Z');
    expect(usageMonth(anchor, new Date('2024-02-29T12:14:59Z')).start.toISOString()).toBe(anchor.toISOString());
    const feb = usageMonth(anchor, new Date('2024-02-29T12:15:00Z'));
    expect(feb.start.toISOString()).toBe('2024-02-29T12:15:00.000Z');
    expect(feb.end.toISOString()).toBe('2024-03-31T12:15:00.000Z');
    expect(usageMonth(anchor, new Date('2025-02-28T12:15:00Z')).end.toISOString()).toBe('2025-03-31T12:15:00.000Z');
  });
  it('counts cached input toward the quota but never charges it twice', () => {
    expect(llmUsage({ usage: { prompt_tokens: 1000, precached_prompt_tokens: 9000, completion_tokens: 200 } }, { input: 65, output: 130 }))
      .toEqual({ inputTokens: 10000, outputTokens: 200, costMicros: 91000, audioSeconds: 0 });
    expect(llmUsage({ usage: { prompt_tokens: -1, completion_tokens: 2 } }, { input: 65, output: 65 })).toBeNull();
    expect(llmUsage({}, { input: 65, output: 65 })).toBeNull();
  });
  it('charges the provider minimum once and rounds speech duration up to full seconds', () => {
    const service = new UsageService({} as never, new ConfigService({}));
    expect(service.speechAmount(1.1, 'yandex')).toMatchObject({ audioSeconds: 2, costMicros: 151500 });
    expect(service.speechAmount(15.1, 'yandex')).toMatchObject({ audioSeconds: 16, costMicros: 161600 });
    expect(() => service.speechAmount(60, 'unknown')).toThrow();
    expect(() => service.rates('unpriced-model')).toThrow();
  });
  it('applies the agreed capacities, with token ceilings only on trial', () => {
    expect(LIMITS.TRIAL).toMatchObject({ budgetRub: 150, inputTokens: 500000, outputTokens: 200000, audioSeconds: 10800 });
    expect(Object.values(LIMITS).map(l => l.budgetRub)).toEqual([150, 1000, 2500, 6000]);
    expect(LIMITS.ENTERPRISE).toMatchObject({ users: 30, tasks: 3000, storageBytes: 100000000000, inputTokens: null, outputTokens: null });
  });
});
