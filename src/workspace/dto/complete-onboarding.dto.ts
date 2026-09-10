import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  IsEmail,
  IsOptional,
  IsString,
  IsIn,
  Length,
  Matches,
} from "class-validator";

const SITE_RE = /^(https?:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i;

export class CompleteOnboardingDto {
  @ApiProperty({
    example: "ООО «Вектор»",
    description: "Название компании",
  })
  @IsString({ message: "Название компании должно быть строкой." })
  @Length(1, 255, {
    message: "Название компании должно быть от 1 до 255 символов.",
  })
  readonly company!: string;

  @ApiProperty({
    example: "IT и SaaS",
    description: "Отрасль",
  })
  @IsString({ message: "Отрасль должна быть строкой." })
  @Length(1, 100, { message: "Отрасль должна быть от 1 до 100 символов." })
  @IsIn(["IT и SaaS", "Ритейл и e-commerce", "Производство", "Услуги и B2B", "Финансы", "Строительство", "Логистика", "Другое"], { message: "Выберите отрасль из списка." })
  readonly industry!: string;

  @ApiPropertyOptional({
    example: "Разработка ПО",
    description: "Описание отрасли (если выбрано «Другое»)",
  })
  @IsOptional()
  @IsString({ message: "Описание отрасли должно быть строкой." })
  @Length(0, 255, {
    message: "Описание отрасли должно быть до 255 символов.",
  })
  readonly industryOther?: string;

  @ApiPropertyOptional({
    example: "company.ru",
    description: "Сайт компании",
  })
  @IsOptional()
  @IsString({ message: "Сайт должен быть строкой." })
  @Matches(SITE_RE, {
    message: "Похоже, адрес сайта некорректен — пример: company.ru",
  })
  @Transform(({ value }) => typeof value === "string" ? value.trim() || undefined : value)
  readonly site?: string;

  @ApiProperty({
    example: "6–20",
    description: "Количество сотрудников",
  })
  @IsString({ message: "Количество сотрудников должно быть строкой." })
  @Length(1, 50, {
    message: "Количество сотрудников должно быть от 1 до 50 символов.",
  })
  @IsIn(["1–5", "6–20", "21–50", "51–200", "200+"], { message: "Выберите количество сотрудников." })
  readonly employees!: string;

  @ApiProperty({
    example: "2–3",
    description: "Количество руководителей",
  })
  @IsString({ message: "Количество руководителей должно быть строкой." })
  @Length(1, 50, {
    message: "Количество руководителей должно быть от 1 до 50 символов.",
  })
  @IsIn(["1", "2–3", "4–10", "10+"], { message: "Выберите количество руководителей." })
  readonly managers!: string;

  @ApiPropertyOptional({
    example: "50–100 млн ₽",
    description: "Примерный оборот",
  })
  @IsOptional()
  @IsString({ message: "Оборот должен быть строкой." })
  @Length(0, 100, { message: "Оборот должен быть до 100 символов." })
  readonly revenue?: string;

  @ApiProperty({
    example: "growth",
    description: "Стадия бизнеса",
  })
  @IsString({ message: "Стадия бизнеса должна быть строкой." })
  @Length(1, 50, {
    message: "Стадия бизнеса должна быть от 1 до 50 символов.",
  })
  @IsIn(["startup", "growth", "mature", "transform"], { message: "Выберите стадию бизнеса." })
  readonly stage!: string;

  @ApiProperty({
    example: "Иван Иванов",
    description: "Имя собственника",
  })
  @IsString({ message: "Имя должно быть строкой." })
  @Length(1, 100, { message: "Имя должно быть от 1 до 100 символов." })
  readonly ownerName!: string;

  @ApiProperty({
    example: "Собственник",
    description: "Должность собственника",
  })
  @IsString({ message: "Должность должна быть строкой." })
  @Length(1, 100, {
    message: "Должность должна быть от 1 до 100 символов.",
  })
  @IsIn(["Собственник", "Основатель", "Генеральный директор", "Управляющий партнёр", "Другое"], { message: "Выберите вашу роль." })
  readonly ownerRole!: string;

  @ApiPropertyOptional({
    example: "Коммерческий директор",
    description: "Описание должности (если выбрано «Другое»)",
  })
  @IsOptional()
  @IsString({ message: "Описание должности должно быть строкой." })
  @Length(0, 255, {
    message: "Описание должности должно быть до 255 символов.",
  })
  readonly roleOther?: string;

  @ApiProperty({
    example: "you@company.ru",
    description: "Email собственника",
  })
  @IsEmail({}, {
    message: "Email для связи не распознан.",
  })
  @Transform(({ value }) => typeof value === "string" ? value.trim() : value)
  readonly ownerEmail!: string;

  @ApiProperty({
    example: "Увеличить выручку с 50 до 100 млн ₽",
    description: "Главная цель компании",
  })
  @IsString({ message: "Цель должна быть строкой." })
  @Length(1, 1000, { message: "Цель должна быть от 1 до 1000 символов." })
  readonly goal!: string;

  @ApiProperty({
    example: "Низкая автоматизация процессов",
    description: "Главная проблема",
  })
  @IsString({ message: "Проблема должна быть строкой." })
  @Length(1, 1000, { message: "Проблема должна быть от 1 до 1000 символов." })
  readonly problem!: string;

  @ApiPropertyOptional({
    example: "Автоматизировать отчётность",
    description: "Приоритет 1",
  })
  @IsOptional()
  @IsString({ message: "Приоритет должен быть строкой." })
  @Length(0, 500, { message: "Приоритет должен быть до 500 символов." })
  readonly priority1?: string;

  @ApiPropertyOptional({
    example: "Внедрить систему контроля задач",
    description: "Приоритет 2",
  })
  @IsOptional()
  @IsString({ message: "Приоритет должен быть строкой." })
  @Length(0, 500, { message: "Приоритет должен быть до 500 символов." })
  readonly priority2?: string;

  @ApiPropertyOptional({
    example: "Обучить руководителей",
    description: "Приоритет 3",
  })
  @IsOptional()
  @IsString({ message: "Приоритет должен быть строкой." })
  @Length(0, 500, { message: "Приоритет должен быть до 500 символов." })
  readonly priority3?: string;
}
