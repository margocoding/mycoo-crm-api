import { ApiProperty } from "@nestjs/swagger";
import { Expose, Type } from "class-transformer";

export class DiagnosticsOptionRdo {
  @ApiProperty({ example: "Устно, в моменте" })
  @Expose()
  text!: string;

  @ApiProperty({ example: 0.2 })
  @Expose()
  score!: number;
}

export class DiagnosticsQuestionRdo {
  @ApiProperty({ example: "q1" })
  @Expose()
  id!: string;

  @ApiProperty({ example: "Как сейчас ставятся задачи?" })
  @Expose()
  question!: string;

  @ApiProperty({ type: [DiagnosticsOptionRdo] })
  @Expose()
  @Type(() => DiagnosticsOptionRdo)
  options!: DiagnosticsOptionRdo[];
}