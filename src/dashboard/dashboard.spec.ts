import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { dashboardPeriod } from './dashboard.service.js';
import { parseDashboardAnalysis } from '../gigachat/dashboard-analysis.js';

const result = { goalProgress: 40, goalExplanation: 'Выполнена часть плана.', risks: [], recommendation: 'Уточните сроки оставшихся задач.' };

describe('Dashboard analysis validation', () => {
  it('accepts a structured estimate, including zero progress and unknown progress', () => {
    for (const goalProgress of [0, 40, 100, null]) {
      expect(parseDashboardAnalysis('```json\n' + JSON.stringify({ ...result, goalProgress }) + '\n```').goalProgress).toBe(goalProgress);
    }
  });
  it.each([-1, 101, 0.5, '40', undefined])('rejects invalid progress %s', goalProgress => {
    expect(() => parseDashboardAnalysis(JSON.stringify({ ...result, goalProgress }))).toThrow();
  });
  it('rejects incomplete answers and unsafe risk structure', () => {
    for (const value of ['not JSON', '[]', '{}', JSON.stringify({ ...result, recommendation: '' }),
      JSON.stringify({ ...result, risks: [{ tone: 'ok', text: 'Это не риск' }] }),
      JSON.stringify({ ...result, risks: Array(9).fill({ tone: 'warn', text: 'Риск' }) })]) {
      expect(() => parseDashboardAnalysis(value)).toThrow();
    }
  });
});

describe('Dashboard reporting week', () => {
  it('uses seven calendar days including today in Moscow across month/year boundaries', () => {
    const period = dashboardPeriod(new Date('2026-12-31T21:30:00Z'));
    expect(period.start.toISOString()).toBe('2026-12-26T00:00:00.000Z');
    expect(period.end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(period.since.toISOString()).toBe('2026-12-25T21:00:00.000Z');
    expect(period.until.toISOString()).toBe('2027-01-01T21:00:00.000Z');
  });
});
