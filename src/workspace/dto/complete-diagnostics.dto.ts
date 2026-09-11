import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, Length, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { DiagnosticsAnswerDto } from "./diagnostics-answer.dto.js";

export class CompleteDiagnosticsDto {
  @ApiPropertyOptional({ description: "Workspace, которому принадлежат ответы" })
  @IsOptional()
  @IsString()
  @Length(1, 100)
  readonly workspaceId?: string;

  @ApiProperty({
    type: [DiagnosticsAnswerDto],
    description: "Ответы на вопросы диагностики",
  })
  @IsArray()
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
