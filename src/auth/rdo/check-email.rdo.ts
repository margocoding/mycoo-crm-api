import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class CheckEmailRdo {
  @ApiProperty({
    example: true,
    description:
      "true — пользователь существует, нужно вводить пароль; false — пользователя нет, нужна регистрация",
  })
  @Expose()
  success!: boolean;
}