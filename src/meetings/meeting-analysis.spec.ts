import { describe, expect, it } from 'vitest';
import { parseMeetingAnalysis } from './meeting-analysis.js';
const data = {
  summary: 'Итог',
  ownerSummary: 'Решение',
  decisions: [],
  risks: [],
  openQuestions: [],
  tasks: [
    {
      title: 'План',
      assigneeIds: [],
      startDate: null,
      dueDate: null,
      successCriteria: '',
      priority: 'medium',
    },
  ],
};
describe('Meeting protocol validation', () => {
  it('keeps unknown assignees and unmentioned deadlines empty', () => {
    const parsed = parseMeetingAnalysis(
      '```json\n' + JSON.stringify(data) + '\n```',
    );
    expect(parsed.tasks[0]).toMatchObject({
      assigneeIds: [],
      startDate: null,
      dueDate: null,
      successCriteria: '',
    });
  });
  it.each(['2026-02-30', '2026-09-31', 'tomorrow'])(
    'rejects invented or invalid date %s',
    (date) => {
      expect(() =>
        parseMeetingAnalysis(
          JSON.stringify({
            ...data,
            tasks: [{ ...data.tasks[0], dueDate: date }],
          }),
        ),
      ).toThrow();
    },
  );
  it('rejects prose, truncated JSON and oversized task lists', () => {
    for (const value of [
      'Some text',
      JSON.stringify(data).slice(0, -1),
      JSON.stringify({ ...data, tasks: Array(51).fill(data.tasks[0]) }),
    ])
      expect(() => parseMeetingAnalysis(value)).toThrow();
  });
});
