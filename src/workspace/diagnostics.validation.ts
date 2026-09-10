import { BadRequestException } from '@nestjs/common';
import { DIAGNOSTICS_QUESTIONS } from './constants/diagnostics-question.constant.js';
import type { DiagnosticsAnswerDto } from './dto/diagnostics-answer.dto.js';

export interface ValidatedAnswer {
  questionId: string;
  opt?: number;
  text?: string;
  skip: boolean;
}

// Only server-known questions and valid option indices can reach the model.
export function validateAnswers(
  answers: DiagnosticsAnswerDto[],
): ValidatedAnswer[] {
  const seen = new Set<string>();
  const result: ValidatedAnswer[] = [];
  for (const answer of answers) {
    const question = DIAGNOSTICS_QUESTIONS.find(
      (q) => q.id === answer.questionId,
    );
    if (!question) continue;
    if (seen.has(question.id))
      throw new BadRequestException(
        'На каждый вопрос можно передать один ответ.',
      );
    seen.add(question.id);
    if (answer.skip) {
      result.push({ questionId: question.id, skip: true });
      continue;
    }
    const opt =
      Number.isInteger(answer.opt) &&
      answer.opt! >= 0 &&
      answer.opt! < question.options.length
        ? answer.opt
        : undefined;
    const text = typeof answer.text === 'string' ? answer.text.trim() : '';
    if (opt === undefined && !text) continue;
    result.push({
      questionId: question.id,
      opt,
      text: text || undefined,
      skip: false,
    });
  }
  if (!result.some((a) => !a.skip))
    throw new BadRequestException(
      'Ответьте хотя бы на один вопрос диагностики.',
    );
  return result;
}
