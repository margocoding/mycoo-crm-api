import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class AiCooScopeDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  departmentId?: string;
}

export class AiCooMessageDto extends AiCooScopeDto {
  @IsUUID('4')
  requestId!: string;

  @IsString()
  @MaxLength(8000)
  text!: string;
}
