import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty } from "class-validator";

export class CheckEmailDto {
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
}