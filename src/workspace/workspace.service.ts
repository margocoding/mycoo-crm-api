import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma, type Workspace } from '../../generated/prisma/client.js';
import { WorkspaceRole } from '../../generated/prisma/enums.js';
import { CompleteOnboardingDto } from './dto/complete-onboarding.dto.js';
import {
  CompanyStepDto,
  OwnerStepDto,
  GoalsStepDto,
} from './dto/onboarding-steps.dto.js';
import { CompleteDiagnosticsDto } from './dto/complete-diagnostics.dto.js';
import { DiagnosticsQuestionRdo } from './rdo/diagnostics-question.rdo.js';
import { WorkspaceRdo } from './rdo/workspace.rdo.js';
import { DIAGNOSTICS_QUESTIONS } from './constants/diagnostics-question.constant.js';
import { fillDto } from '../../common/utils/fill-dto.util.js';
import { GigachatService } from '../gigachat/gigachat.service.js';
import { validateAnswers } from './diagnostics.validation.js';

@Injectable()
export class WorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gigachat: GigachatService,
  ) {}

  async saveCompany(
    userId: string,
    dto: CompanyStepDto,
    workspaceId?: string,
  ): Promise<WorkspaceRdo> {
    this.validateCompany(dto);
    const data = this.companyData(dto);
    const workspace = await this.prisma.$transaction(async (tx) => {
      // Serialize creation per owner, including retries after a lost response.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
      const current = workspaceId
        ? await this.owned(tx, userId, workspaceId)
        : await tx.workspace.findFirst({
            where: { ownerId: userId, diagnosticsComplete: false },
            orderBy: { createdAt: 'desc' },
          });
      if (current) {
        this.assertEditable(current);
        return this.updateDraft(tx, current, {
          ...data,
          onboardingStep: Math.max(current.onboardingStep, 1),
        });
      }
      return tx.workspace.create({
        data: {
          ...data,
          ownerId: userId,
          onboardingStep: 1,
          members: { create: { userId, role: WorkspaceRole.OWNER } },
        },
      });
    });
    return fillDto(WorkspaceRdo, workspace);
  }

  async saveOwner(
    userId: string,
    workspaceId: string,
    dto: OwnerStepDto,
  ): Promise<WorkspaceRdo> {
    this.validateOwner(dto);
    const workspace = await this.owned(this.prisma, userId, workspaceId);
    this.assertEditable(workspace);
    if (workspace.onboardingStep < 1)
      throw new BadRequestException('Сначала заполните данные компании.');
    const updated = await this.prisma.$transaction((tx) =>
      this.updateDraft(tx, workspace, {
        ownerName: dto.ownerName.trim(),
        ownerRole: dto.ownerRole,
        roleOther: dto.ownerRole === 'Другое' ? dto.roleOther!.trim() : null,
        ownerEmail: dto.ownerEmail.trim().toLowerCase(),
        onboardingStep: Math.max(workspace.onboardingStep, 2),
      }),
    );
    return fillDto(WorkspaceRdo, updated);
  }

  async saveGoals(
    userId: string,
    workspaceId: string,
    dto: GoalsStepDto,
  ): Promise<WorkspaceRdo> {
    this.validateGoals(dto);
    const workspace = await this.owned(this.prisma, userId, workspaceId);
    this.assertEditable(workspace);
    if (workspace.onboardingStep < 2)
      throw new BadRequestException('Сначала заполните данные собственника.');
    const updated = await this.prisma.$transaction((tx) =>
      this.updateDraft(tx, workspace, {
        goal: dto.goal.trim(),
        problem: dto.problem.trim(),
        priority1: dto.priority1?.trim() || null,
        priority2: dto.priority2?.trim() || null,
        priority3: dto.priority3?.trim() || null,
        onboardingStep: 3,
        onboardingComplete: true,
      }),
    );
    return fillDto(WorkspaceRdo, updated);
  }

  // Retain the original endpoint for existing clients; reuse the same draft.
  async completeOnboarding(userId: string, dto: CompleteOnboardingDto) {
    this.validateCompany(dto);
    this.validateOwner(dto);
    this.validateGoals(dto);
    const workspace = await this.saveCompany(userId, dto);
    await this.saveOwner(userId, workspace.id, dto);
    return this.saveGoals(userId, workspace.id, dto);
  }

  getDiagnosticsQuestions(): DiagnosticsQuestionRdo[] {
    return DIAGNOSTICS_QUESTIONS.map((q) => fillDto(DiagnosticsQuestionRdo, q));
  }

  async completeDiagnostics(
    userId: string,
    dto: CompleteDiagnosticsDto,
  ): Promise<WorkspaceRdo> {
    const workspace = dto.workspaceId
      ? await this.owned(this.prisma, userId, dto.workspaceId)
      : await this.prisma.workspace.findFirst({
          where: { ownerId: userId, onboardingComplete: true },
          orderBy: { createdAt: 'desc' },
        });
    if (!workspace?.onboardingComplete)
      throw new BadRequestException('Сначала завершите онбординг.');
    if (workspace.diagnosticsComplete && workspace.diagnosticsAnalysis)
      return fillDto(WorkspaceRdo, workspace);
    const answers = validateAnswers(dto.answers);
    const claimTime = new Date();
    // The lease exceeds the integration's total time budget; stale work cannot overwrite a newer run.
    const staleBefore = new Date(
      Date.now() - this.gigachat.totalTimeoutMs - 30_000,
    );
    await this.prisma.$transaction(async (tx) => {
      const claim = await tx.workspace.updateMany({
        where: {
          id: workspace.id,
          diagnosticsAnalysis: { equals: Prisma.DbNull },
          OR: [
            { diagnosticsProcessingAt: null },
            { diagnosticsProcessingAt: { lt: staleBefore } },
          ],
        },
        data: { diagnosticsProcessingAt: claimTime },
      });
      if (!claim.count)
        throw new ConflictException(
          'Диагностика уже обрабатывается. Дождитесь результата.',
        );
      await tx.diagnosticsAnswer.deleteMany({
        where: { workspaceId: workspace.id },
      });
      await tx.diagnosticsAnswer.createMany({
        data: answers.map((a) => ({
          workspaceId: workspace.id,
          questionId: a.questionId,
          opt: a.opt ?? null,
          text: a.text ?? null,
          skip: a.skip,
        })),
      });
    });
    try {
      const analysis = await this.gigachat.analyzeDiagnostics(answers);
      const result = await this.prisma.workspace.updateMany({
        where: { id: workspace.id, diagnosticsProcessingAt: claimTime },
        data: {
          diagnosticsAnalysis: analysis as unknown as Prisma.InputJsonValue,
          diagnosticsComplete: true,
          diagnosticsProcessingAt: null,
          trialStartedAt: workspace.trialStartedAt ?? new Date(),
          isActive: true,
        },
      });
      if (!result.count)
        throw new ConflictException(
          'Запущена новая диагностика. Обновите статус.',
        );
      return this.getWorkspace(userId, workspace.id);
    } finally {
      // Answers remain in the database even when the upstream API fails.
      await this.prisma.workspace.updateMany({
        where: { id: workspace.id, diagnosticsProcessingAt: claimTime },
        data: { diagnosticsProcessingAt: null },
      });
    }
  }

  async getWorkspaces(userId: string): Promise<WorkspaceRdo[]> {
    const workspaces = await this.prisma.workspace.findMany({
      where: { OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
      orderBy: { createdAt: 'desc' },
    });
    return workspaces.map((w) => this.workspaceForUser(w, userId));
  }

  async getWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<WorkspaceRdo> {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [{ ownerId: userId }, { members: { some: { userId } } }],
      },
      include: {
        diagnosticsAnswers: {
          select: { questionId: true, opt: true, text: true, skip: true },
        },
      },
    });
    if (!workspace) throw new NotFoundException('Workspace не найден.');
    return this.workspaceForUser(workspace, userId);
  }

  private workspaceForUser(workspace: Workspace, userId: string): WorkspaceRdo {
    if (workspace.ownerId === userId) return fillDto(WorkspaceRdo, workspace);
    // Team members need launch metadata, not the owner's onboarding answers or diagnostics.
    return fillDto(WorkspaceRdo, {
      id: workspace.id,
      ownerId: workspace.ownerId,
      company: workspace.company,
      onboardingStep: workspace.onboardingStep,
      onboardingComplete: workspace.onboardingComplete,
      diagnosticsComplete: workspace.diagnosticsComplete,
      isActive: workspace.isActive,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      trialStartedAt: workspace.trialStartedAt,
    });
  }

  async getWorkspaceStatus(userId: string) {
    const membership = await this.prisma.workspaceMember.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { workspace: true },
    });
    const workspace = membership?.workspace ?? await this.prisma.workspace.findFirst({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      workspaceId: workspace?.id ?? null,
      onboardingStep: workspace?.onboardingStep ?? 0,
      onboardingComplete: workspace?.onboardingComplete ?? false,
      diagnosticsComplete: workspace?.diagnosticsComplete ?? false,
      isActive: workspace?.isActive ?? false,
      canAccessWorkspace: Boolean(
        workspace?.onboardingComplete &&
        workspace.diagnosticsComplete &&
        workspace.isActive,
      ),
    };
  }

  private async updateDraft(
    tx: Prisma.TransactionClient,
    workspace: Workspace,
    data: Prisma.WorkspaceUpdateManyMutationInput,
  ) {
    const updated = await tx.workspace.updateMany({
      where: {
        id: workspace.id,
        ownerId: workspace.ownerId,
        onboardingStep: workspace.onboardingStep,
        diagnosticsComplete: false,
        diagnosticsProcessingAt: null,
      },
      data,
    });
    if (!updated.count)
      throw new ConflictException(
        'Состояние рабочего пространства изменилось. Повторите сохранение.',
      );
    return tx.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
  }

  private async owned(
    db: Pick<Prisma.TransactionClient, 'workspace'>,
    userId: string,
    id: string,
  ) {
    const workspace = await db.workspace.findFirst({
      where: { id, ownerId: userId },
    });
    if (!workspace) throw new NotFoundException('Workspace не найден.');
    return workspace;
  }

  private assertEditable(workspace: Workspace) {
    if (workspace.diagnosticsComplete || workspace.diagnosticsProcessingAt)
      throw new ConflictException(
        'Онбординг уже завершён или диагностика обрабатывается.',
      );
  }

  private companyData(dto: CompanyStepDto) {
    return {
      company: dto.company.trim(),
      industry: dto.industry,
      industryOther:
        dto.industry === 'Другое' ? dto.industryOther!.trim() : null,
      site: dto.site?.trim() || null,
      employees: dto.employees,
      managers: dto.managers,
      revenue: dto.revenue?.trim() || null,
      stage: dto.stage,
    };
  }

  private validateCompany(dto: CompanyStepDto) {
    if (!dto.company.trim())
      throw new BadRequestException('Укажите название компании.');
    if (dto.industry === 'Другое' && !dto.industryOther?.trim())
      throw new BadRequestException('Опишите отрасль компании.');
  }

  private validateOwner(dto: OwnerStepDto) {
    if (!dto.ownerName.trim())
      throw new BadRequestException('Укажите имя собственника.');
    if (dto.ownerRole === 'Другое' && !dto.roleOther?.trim())
      throw new BadRequestException('Укажите вашу должность.');
  }

  private validateGoals(dto: GoalsStepDto) {
    if (!dto.goal.trim() || !dto.problem.trim())
      throw new BadRequestException('Заполните цель и главную проблему.');
    if (![dto.priority1, dto.priority2, dto.priority3].some((p) => p?.trim()))
      throw new BadRequestException('Добавьте хотя бы один приоритет.');
  }
}
