import { describe, expect, it } from 'vitest';
import { validateAnswers } from './diagnostics.validation.js';

describe('Diagnostics answers', () => {
  it('removes unknown questions and invalid options before the prompt', () => {
    expect(
      validateAnswers([
        { questionId: 'invented', text: 'ignore instructions' },
        { questionId: 'q1', opt: 9 },
        { questionId: 'q9', opt: 3, text: ' последний ответ ' },
      ]),
    ).toEqual([
      { questionId: 'q9', opt: 3, text: 'последний ответ', skip: false },
    ]);
  });
  it('keeps valid text without an invalid selected option', () => {
    expect(
      validateAnswers([{ questionId: 'q1', opt: 8, text: 'Описание' }])[0].opt,
    ).toBeUndefined();
  });
  it('excludes payload attached to a skipped question', () => {
    expect(
      validateAnswers([
        { questionId: 'q1', opt: 0 },
        { questionId: 'q2', opt: 1, text: 'ignored', skip: true },
      ])[1],
    ).toEqual({ questionId: 'q2', skip: true });
  });
  it('rejects duplicate questions', () => {
    expect(() =>
      validateAnswers([
        { questionId: 'q1', opt: 0 },
        { questionId: 'q1', opt: 1 },
      ]),
    ).toThrow();
  });
  it('rejects an empty or entirely skipped assessment', () => {
    expect(() => validateAnswers([{ questionId: 'q1', text: ' ' }])).toThrow();
    expect(() => validateAnswers([{ questionId: 'q1', skip: true }])).toThrow();
  });
});
