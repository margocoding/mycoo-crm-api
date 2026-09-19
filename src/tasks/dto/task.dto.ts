import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsDateString, IsEmail, IsIn, IsString, Length, Matches, MaxLength } from 'class-validator';

export const taskStatuses = ['backlog', 'in-progress', 'review', 'done'] as const;
export type TaskStatus = typeof taskStatuses[number];

export class TaskDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @Length(1, 200, { message: 'Название задачи: от 1 до 200 символов.' })
  title!: string;

  @Transform(({ value }: { value: unknown }) => Array.isArray(value)
    ? value.map((email: unknown) => typeof email === 'string' ? email.trim().toLowerCase() : email) : value)
  @IsArray()
  @ArrayMinSize(1, { message: 'Выберите хотя бы одного исполнителя.' })
  @ArrayMaxSize(50, { message: 'Можно выбрать не более 50 исполнителей.' })
  @ArrayUnique({ message: 'Исполнители не должны повторяться.' })
  @IsEmail({}, { each: true, message: 'Укажите корректный email исполнителя.' })
  @MaxLength(254, { each: true })
  assigneeEmails!: string[];

  @Matches(/^[1-9]\d{3}-\d{2}-\d{2}$/, { message: 'Укажите срок задачи в формате ГГГГ-ММ-ДД.' })
  @IsDateString({ strict: true }, { message: 'Укажите существующую дату срока задачи.' })
  dueDate!: string;

  @IsIn(['low', 'medium', 'high'], { message: 'Выберите приоритет задачи.' })
  priority!: 'low' | 'medium' | 'high';

  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MaxLength(3000, { message: 'Критерий результата: не более 3000 символов.' })
  successCriteria!: string;
}

export class TaskStatusDto {
  @IsIn(taskStatuses, { message: 'Выберите допустимый статус задачи.' })
  status!: TaskStatus;
}
