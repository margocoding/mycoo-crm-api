import { PickType } from '@nestjs/swagger';
import { RegisterUserDto } from './register-user.dto.js';

export class VerifyCodeDto extends PickType(RegisterUserDto, [
  'email',
  'code',
] as const) {}
