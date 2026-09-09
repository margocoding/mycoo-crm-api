import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { DiagnosticsAnswerDto } from "./diagnostics-answer.dto.js";

export class CompleteDiagnosticsDto {
  @ApiProperty({
    type: [DiagnosticsAnswerDto],
    description: "Ответы на вопросы диагностики",
  })
  @ArrayMinSize(1, {
    message: "Должен быть хотя бы один ответ.",
  })
  @ArrayMaxSize(20, {
    message: "Максимум 20 ответов.",
  })
  @ValidateNested({ each: true })
  @Type(() => DiagnosticsAnswerDto)
  readonly answers!: DiagnosticsAnswerDto[];
}