import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";

export class DiagnosticsAnswerDto {
  @ApiProperty({
    example: "q1",
    description: "ID вопроса",
  })
  @IsString({ message: "ID вопроса должен быть строкой." })
  @Length(1, 50, { message: "ID вопроса должен быть от 1 до 50 символов." })
  readonly questionId!: string;

  @ApiPropertyOptional({
    example: 2,
    description: "Индекс выбранного варианта ответа",
  })
  @IsOptional()
  @IsInt({ message: "Индекс варианта должен быть целым числом." })
  @Min(0, { message: "Индекс варианта должен быть >= 0." })
  @Max(10, { message: "Индекс варианта должен быть <= 10." })
  readonly opt?: number;

  @ApiPropertyOptional({
    example: "Задачи ставлю лично в Telegram",
    description: "Текстовый ответ",
  })
  @IsOptional()
  @IsString({ message: "Текстовый ответ должен быть строкой." })
  @Length(0, 1000, {
    message: "Текстовый ответ должен быть до 1000 символов.",
  })
  readonly text?: string;

  @ApiPropertyOptional({
    example: false,
    description: "Пропущен ли вопрос",
  })
  @IsOptional()
  @IsBoolean({ message: "skip должен быть булевым значением." })
  readonly skip?: boolean;
}