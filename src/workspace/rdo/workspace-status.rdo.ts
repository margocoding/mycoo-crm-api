import { ApiProperty } from "@nestjs/swagger";
import { Expose } from "class-transformer";

export class WorkspaceStatusRdo {
  @ApiProperty({ type: String, nullable: true })
  @Expose()
  workspaceId!: string | null;

  @ApiProperty({ example: 1 })
  @Expose()
  onboardingStep!: number;

  @ApiProperty({ example: true })
  @Expose()
  onboardingComplete!: boolean;

  @ApiProperty({ example: false })
  @Expose()
  diagnosticsComplete!: boolean;

  @ApiProperty({ example: false })
  @Expose()
  isActive!: boolean;

  @ApiProperty({ example: true })
  @Expose()
  canAccessWorkspace!: boolean;
}
