import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { JwtPayload } from "../../common/types/auth.types.js";
import { JwtAuthGuard } from "../auth/jwt-auth.guard.js";
import { WorkspaceService } from "./workspace.service.js";
import { CompleteOnboardingDto } from "./dto/complete-onboarding.dto.js";
import { SuccessRdo } from "../../common/rdo/success.rdo.js";
import { DiagnosticsQuestionRdo } from "./rdo/diagnostics-question.rdo.js";
import { CompleteDiagnosticsDto } from "./dto/complete-diagnostics.dto.js";
import { WorkspaceRdo } from "./rdo/workspace.rdo.js";
import { WorkspaceStatusRdo } from "./rdo/workspace-status.rdo.js";

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@ApiTags("workspace")
@ApiBearerAuth()
@Controller("workspace")
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post("onboarding/complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Завершить онбординг и сохранить данные компании",
  })
  @ApiBody({ type: CompleteOnboardingDto })
  @ApiResponse({
    status: HttpStatus.OK,
    type: SuccessRdo,
  })
  completeOnboarding(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CompleteOnboardingDto,
  ) {
    const userId = request.user!.sub;

    return this.workspaceService.completeOnboarding(userId, dto);
  }

  @Get("diagnostics/questions")
  @ApiOperation({
    summary: "Получить список вопросов для диагностики",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: [DiagnosticsQuestionRdo],
  })
  getDiagnosticsQuestions() {
    return this.workspaceService.getDiagnosticsQuestions();
  }

  @Post("diagnostics/complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Завершить диагностику и сохранить ответы",
  })
  @ApiBody({ type: CompleteDiagnosticsDto })
  @ApiResponse({
    status: HttpStatus.OK,
    type: SuccessRdo,
  })
  completeDiagnostics(
    @Req() request: AuthenticatedRequest,
    @Body() dto: CompleteDiagnosticsDto,
  ) {
    const userId = request.user!.sub;

    return this.workspaceService.completeDiagnostics(userId, dto);
  }

  @Get("list")
  @ApiOperation({
    summary: "Получить список workspace'ов пользователя",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: [WorkspaceRdo],
  })
  getWorkspaces(@Req() request: AuthenticatedRequest) {
    const userId = request.user!.sub;

    return this.workspaceService.getWorkspaces(userId);
  }

  @Get(":id")
  @ApiOperation({
    summary: "Получить конкретный workspace",
  })
  @ApiParam({ name: "id", description: "Идентификатор workspace" })
  @ApiResponse({
    status: HttpStatus.OK,
    type: WorkspaceRdo,
  })
  getWorkspace(
    @Req() request: AuthenticatedRequest,
    @Param("id") id: string,
  ) {
    const userId = request.user!.sub;

    return this.workspaceService.getWorkspace(userId, id);
  }

  @Get("status")
  @ApiOperation({
    summary: "Получить статус завершения этапов workspace",
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: WorkspaceStatusRdo,
  })
  getWorkspaceStatus(@Req() request: AuthenticatedRequest) {
    const userId = request.user!.sub;

    return this.workspaceService.getWorkspaceStatus(userId);
  }
}