import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import type { JwtPayload } from '../../common/types/auth.types.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { WorkspaceService } from './workspace.service.js';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto.js';
import {
  CompanyStepDto,
  OwnerStepDto,
  GoalsStepDto,
} from './dto/onboarding-steps.dto.js';
import { CompleteDiagnosticsDto } from './dto/complete-diagnostics.dto.js';
import { CompletedWorkspaceRdo, WorkspaceRdo } from './rdo/workspace.rdo.js';
import { WorkspaceStatusRdo } from './rdo/workspace-status.rdo.js';
import { DiagnosticsQuestionRdo } from './rdo/diagnostics-question.rdo.js';

interface AuthenticatedRequest extends Request {
  user?: JwtPayload;
}

@ApiTags('workspace')
@ApiBearerAuth()
@Controller('workspace')
@UseGuards(JwtAuthGuard)
export class WorkspaceController {
  constructor(private readonly workspaceService: WorkspaceService) {}

  @Post('onboarding/company')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Сохранить компанию и создать или продолжить черновик',
  })
  @ApiResponse({ status: 200, type: WorkspaceRdo })
  createCompany(@Req() req: AuthenticatedRequest, @Body() dto: CompanyStepDto) {
    return this.workspaceService.saveCompany(req.user!.sub, dto);
  }

  @Patch(':id/onboarding/company')
  @ApiResponse({ status: 200, type: WorkspaceRdo })
  saveCompany(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: CompanyStepDto,
  ) {
    return this.workspaceService.saveCompany(req.user!.sub, dto, id);
  }

  @Patch(':id/onboarding/owner')
  @ApiResponse({ status: 200, type: WorkspaceRdo })
  saveOwner(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: OwnerStepDto,
  ) {
    return this.workspaceService.saveOwner(req.user!.sub, id, dto);
  }

  @Patch(':id/onboarding/goals')
  @ApiResponse({ status: 200, type: WorkspaceRdo })
  saveGoals(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: GoalsStepDto,
  ) {
    return this.workspaceService.saveGoals(req.user!.sub, id, dto);
  }

  @Post('onboarding/complete')
  @HttpCode(200)
  @ApiResponse({ status: 200, type: CompletedWorkspaceRdo })
  async completeOnboarding(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CompleteOnboardingDto,
  ) {
    return { success: true, ...await this.workspaceService.completeOnboarding(req.user!.sub, dto) };
  }

  @Get('diagnostics/questions')
  @ApiResponse({ status: 200, type: [DiagnosticsQuestionRdo] })
  getDiagnosticsQuestions() {
    return this.workspaceService.getDiagnosticsQuestions();
  }

  @Post('diagnostics/complete')
  @HttpCode(200)
  @ApiResponse({ status: 200, type: CompletedWorkspaceRdo })
  async completeDiagnostics(
    @Req() req: AuthenticatedRequest,
    @Body() dto: CompleteDiagnosticsDto,
  ) {
    return { success: true, ...await this.workspaceService.completeDiagnostics(req.user!.sub, dto) };
  }

  @Get('list')
  @ApiResponse({ status: 200, type: [WorkspaceRdo] })
  getWorkspaces(@Req() req: AuthenticatedRequest) {
    return this.workspaceService.getWorkspaces(req.user!.sub);
  }

  @Get('status')
  @ApiResponse({ status: 200, type: WorkspaceStatusRdo })
  getWorkspaceStatus(@Req() req: AuthenticatedRequest) {
    return this.workspaceService.getWorkspaceStatus(req.user!.sub);
  }

  @Get(':id')
  @ApiResponse({ status: 200, type: WorkspaceRdo })
  getWorkspace(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.workspaceService.getWorkspace(req.user!.sub, id);
  }
}
