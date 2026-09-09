import { Injectable, Logger } from "@nestjs/common";

export interface DiagnosticsAnalysis {
  score: number;
  risks: Array<{
    tone: "crit" | "warn" | "ok";
    text: string;
  }>;
  summary: string;
}

@Injectable()
export class GigachatService {
  private readonly logger = new Logger(GigachatService.name);

  async analyzeDiagnostics(
    _answers: Array<{
      questionId: string;
      opt?: number;
      text?: string;
      skip?: boolean;
    }>,
  ): Promise<DiagnosticsAnalysis> {
    this.logger.warn("GigChat analyzeDiagnostics is a stub");

    return {
      score: 65,
      risks: [
        {
          tone: "crit",
          text: "Задачи часто зависят от собственника",
        },
        {
          tone: "warn",
          text: "Нет единой системы контроля",
        },
        {
          tone: "warn",
          text: "Договорённости после встреч не фиксируются",
        },
        {
          tone: "ok",
          text: "Команда готова к единому контуру управления",
        },
      ],
      summary:
        "Контроль держится на ручном управлении. База есть — нужен единый операционный контур.",
    };
  }
}