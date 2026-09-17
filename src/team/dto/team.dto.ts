import { Transform } from 'class-transformer';
import {
  ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEmail, IsEnum,
  IsOptional, IsString, Length, MaxLength,
} from 'class-validator';
import { PickType } from '@nestjs/swagger';
import { DepartmentRole } from '../../../generated/prisma/enums.js';
import { RegisterUserDto } from '../../auth/dto/register-user.dto.js';

const trim = ({ value }: { value: unknown }) => typeof value === 'string' ? value.trim() : value;

export class DepartmentDto {
  @Transform(trim)
  @IsString()
  @Length(2, 80, { message: 'Название департамента: от 2 до 80 символов.' })
  name!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;
}

export class MemberRoleDto {
  @IsEnum(DepartmentRole)
  role!: DepartmentRole;
}

export class MemberDepartmentsDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Выберите хотя бы один департамент.' })
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  departmentIds!: string[];
}

export class InvitationDto extends MemberRoleDto {
  @Transform(({ value }: { value: unknown }) => typeof value === 'string' ? value.trim().toLowerCase() : value)
  @IsEmail({}, { message: 'Укажите корректный email.' })
  @MaxLength(254)
  email!: string;

  @Transform(trim)
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class AcceptInvitationDto extends PickType(RegisterUserDto, ['password'] as const) {}
