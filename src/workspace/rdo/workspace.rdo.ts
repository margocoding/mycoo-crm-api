import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class WorkspaceRdo {
  @ApiProperty({
    example: "ckg5z6j000000l5b7v9x8y2z1",
    description: "Идентификатор workspace",
  })
  @Expose()
  id!: string;

  @ApiProperty({
    example: "ckg5z6j000000l5b7v9x8y2z2",
    description: "Идентификатор владельца",
  })
  @Expose()
  ownerId!: string;

  @ApiPropertyOptional({ example: "ООО «Вектор»" })
  @Expose()
  company?: string | null;

  @ApiPropertyOptional({ example: "IT и SaaS" })
  @Expose()
  industry?: string | null;

  @ApiPropertyOptional({ example: "Разработка ПО" })
  @Expose()
  industryOther?: string | null;

  @ApiPropertyOptional({ example: "company.ru" })
  @Expose()
  site?: string | null;

  @ApiPropertyOptional({ example: "6–20" })
  @Expose()
  employees?: string | null;

  @ApiPropertyOptional({ example: "2–3" })
  @Expose()
  managers?: string | null;

  @ApiPropertyOptional({ example: "50–100 млн ₽" })
  @Expose()
  revenue?: string | null;

  @ApiPropertyOptional({ example: "growth" })
  @Expose()
  stage?: string | null;

  @ApiPropertyOptional({ example: "Иван Иванов" })
  @Expose()
  ownerName?: string | null;

  @ApiPropertyOptional({ example: "Собственник" })
  @Expose()
  ownerRole?: string | null;

  @ApiPropertyOptional({ example: "Коммерческий директор" })
  @Expose()
  roleOther?: string | null;

  @ApiPropertyOptional({ example: "you@company.ru" })
  @Expose()
  ownerEmail?: string | null;

  @ApiPropertyOptional({ example: "Увеличить выручку" })
  @Expose()
  goal?: string | null;

  @ApiPropertyOptional({ example: "Низкая автоматизация" })
  @Expose()
  problem?: string | null;

  @ApiPropertyOptional({ example: "Автоматизировать отчётность" })
  @Expose()
  priority1?: string | null;

  @ApiPropertyOptional({ example: "Внедрить систему контроля" })
  @Expose()
  priority2?: string | null;

  @ApiPropertyOptional({ example: "Обучить руководителей" })
  @Expose()
  priority3?: string | null;

  @ApiProperty({ example: true })
  @Expose()
  onboardingComplete!: boolean;

  @ApiProperty({ example: false })
  @Expose()
  diagnosticsComplete!: boolean;

  @ApiProperty({ example: false })
  @Expose()
  isActive!: boolean;

  @ApiProperty({ type: String, format: "date-time" })
  @Expose()
  createdAt!: Date;

  @ApiProperty({ type: String, format: "date-time" })
  @Expose()
  updatedAt!: Date;

  @ApiPropertyOptional({ type: String, format: "date-time" })
  @Expose()
  trialStartedAt?: Date | null;
}