import { ApiProperty } from "@nestjs/swagger";
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  Length,
  Matches,
} from "class-validator";

export class LoginUserDto {
  @ApiProperty({
    example: "you@company.ru",
    description: "Email пользователя",
  })
  @IsNotEmpty({
    message: "Email не может быть пустым.",
  })
  @IsEmail({}, {
    message: "Формат email не распознан — проверьте адрес.",
  })
  readonly email!: string;

  @ApiProperty({
    example: "Qwerty123",
    description: "Пароль пользователя",
  })
  @IsNotEmpty({
    message: "Пароль не может быть пустым.",
  })
  @IsString({
    message: "Пароль должен быть строкой.",
  })
  @Length(8, 128, {
    message:
      "Пароль должен содержать не менее 8 и не более 128 символов.",
  })
  @Matches(/^(?=.*\d)(?=.*[a-zа-яё])[\s\S]*$/i, {
    message: "Пароль должен содержать буквы и цифры.",
  })
  @Matches(/^(?=.*[a-zа-яё])(?=.*[A-ZА-ЯЁ])[\s\S]*$/, {
    message: "Пароль должен содержать буквы разного регистра.",
  })
  readonly password!: string;

  @ApiProperty({
    example: "123456",
    description: "6-значный код подтверждения",
  })
  @IsNotEmpty({
    message: "Код не может быть пустым.",
  })
  @IsString({
    message: "Код должен быть строкой.",
  })
  @Length(6, 6, {
    message: "Код должен состоять из 6 цифр.",
  })
  @Matches(/^\d{6}$/, {
    message: "Код должен состоять из 6 цифр.",
  })
  readonly code!: string;
}