import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class SuccessRdo {
  @ApiProperty({ example: true })
  @Expose()
  success!: boolean;
}