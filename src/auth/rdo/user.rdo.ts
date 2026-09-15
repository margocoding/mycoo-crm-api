import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class UserRdo {
  @ApiProperty({
    example: "ckg5z6j000000l5b7v9x8y2z1",
    description: "Идентификатор пользователя",
  })
  @Expose()
  id!: string;

  @ApiProperty({
    example: "you@company.ru",
    description: "Email пользователя",
  })
  @Expose()
  email!: string;

  @ApiProperty({ required: false, nullable: true })
  @Expose()
  name?: string | null;

  @ApiProperty({
    example: true,
    description: "Признак подтверждённого email",
  })
  @Expose()
  isEmailConfirmed!: boolean;

  @ApiProperty({
    type: String,
    format: "date-time",
    description: "Дата создания пользователя",
  })
  @Expose()
  createdAt!: Date;
}
