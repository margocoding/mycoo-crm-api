import { ApiProperty } from "@nestjs/swagger";
import { Expose, Type } from "class-transformer";
import { UserRdo } from "./user.rdo.js";

export class AuthRdo {
  @ApiProperty({
    example: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    description: "JWT access token",
  })
  @Expose()
  accessToken!: string;

  @ApiProperty({
    type: () => UserRdo,
    description: "Данные пользователя",
  })
  @Expose()
  @Type(() => UserRdo)
  user!: UserRdo;
}