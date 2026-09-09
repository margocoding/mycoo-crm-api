import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service.js";
import { CompleteOnboardingDto } from "./dto/complete-onboarding.dto.js";
import { SuccessRdo } from "../../common/rdo/success.rdo.js";
import { WorkspaceRole } from "../../generated/prisma/enums.js";
import { DiagnosticsQuestionRdo } from "./rdo/diagnostics-question.rdo.js";
import { DIAGNOSTICS_QUESTIONS } from "./constants/diagnostics-question.constant.js";
import { fillDto } from "../../common/utils/fill-dto.util.js";
import { CompleteDiagnosticsDto } from "./dto/complete-diagnostics.dto.js";
import { WorkspaceRdo } from "./rdo/workspace.rdo.js";
import { WorkspaceStatusRdo } from "./rdo/workspace-status.rdo.js";
import { GigachatService } from "../gigachat/gigachat.service.js";


@Injectable()
export class WorkspaceService {
  private readonly logger = new Logger(WorkspaceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gigachat: GigachatService,
  ) {}

  async completeOnboarding(
    userId: string,
    dto: CompleteOnboardingDto,
  ): Promise<SuccessRdo> {
    this.validateOnboardingDto(dto);

    const normalizedEmail = dto.ownerEmail.trim().toLowerCase();

    // Создаём workspace в транзакции
    await this.prisma.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: {
          ownerId: userId,
          company: dto.company.trim(),
          industry: dto.industry.trim(),
          industryOther: dto.industryOther?.trim() || null,
          site: dto.site?.trim() || null,
          employees: dto.employees.trim(),
          managers: dto.managers.trim(),
          revenue: dto.revenue?.trim() || null,
          stage: dto.stage.trim(),
          ownerName: dto.ownerName.trim(),
          ownerRole: dto.ownerRole.trim(),
          roleOther: dto.roleOther?.trim() || null,
          ownerEmail: normalizedEmail,
          goal: dto.goal.trim(),
          problem: dto.problem.trim(),
          priority1: dto.priority1?.trim() || null,
          priority2: dto.priority2?.trim() || null,
          priority3: dto.priority3?.trim() || null,
          onboardingComplete: true,
        },
      });

      // Добавляем владельца как участника с ролью OWNER
      await tx.workspaceMember.create({
        data: {
          userId,
          workspaceId: workspace.id,
          role: WorkspaceRole.OWNER,
        },
      });

      this.logger.log(
        `Onboarding completed for user ${userId}, workspace ${workspace.id}`,
      );
    });

    return fillDto(SuccessRdo, { success: true });
  }

  async getDiagnosticsQuestions(): Promise<DiagnosticsQuestionRdo[]> {
    return DIAGNOSTICS_QUESTIONS.map((q) =>
      fillDto(DiagnosticsQuestionRdo, q),
    );
  }

  async completeDiagnostics(
    userId: string,
    dto: CompleteDiagnosticsDto,
  ): Promise<SuccessRdo> {
    // Находим активный workspace пользователя
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        ownerId: userId,
        onboardingComplete: true,
        diagnosticsComplete: false,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!workspace) {
      throw new BadRequestException(
        "Онбординг не завершён или диагностика уже пройдена.",
      );
    }

    // Валидируем ответы
    const validQuestionIds = DIAGNOSTICS_QUESTIONS.map((q) => q.id);

    for (const answer of dto.answers) {
      if (!validQuestionIds.includes(answer.questionId)) {
        throw new BadRequestException(
          `Неизвестный вопрос: ${answer.questionId}`,
        );
      }
    }

    const analysis = await this.gigachat.analyzeDiagnostics(
      dto.answers.map((a) => ({
        questionId: a.questionId,
        opt: a.opt,
        text: a.text,
        skip: a.skip,
      })),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.diagnosticsAnswer.deleteMany({
        where: { workspaceId: workspace.id },
      });

      await tx.diagnosticsAnswer.createMany({
        data: dto.answers.map((a) => ({
          workspaceId: workspace.id,
          questionId: a.questionId,
          opt: a.opt ?? null,
          text: a.text?.trim() || null,
          skip: a.skip ?? false,
        })),
      });

      await tx.workspace.update({
        where: { id: workspace.id },
        data: {
          diagnosticsComplete: true,
          trialStartedAt: new Date(),
          isActive: true,
        },
      });

      this.logger.log(
        `Diagnostics completed for workspace ${workspace.id}, score: ${analysis.score}`,
      );
    });

    return fillDto(SuccessRdo, { success: true });
  }

  async getWorkspaces(userId: string): Promise<WorkspaceRdo[]> {
    const workspaces = await this.prisma.workspace.findMany({
      where: {
        OR: [
          { ownerId: userId },
          {
            members: {
              some: {
                userId,
              },
            },
          },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return workspaces.map((w) => fillDto(WorkspaceRdo, w));
  }

  async getWorkspace(userId: string, workspaceId: string): Promise<WorkspaceRdo> {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        id: workspaceId,
        OR: [
          { ownerId: userId },
          {
            members: {
              some: {
                userId,
              },
            },
          },
        ],
      },
    });

    if (!workspace) {
      throw new NotFoundException("Workspace не найден.");
    }

    return fillDto(WorkspaceRdo, workspace);
  }

  async getWorkspaceStatus(userId: string): Promise<WorkspaceStatusRdo> {
    const workspace = await this.prisma.workspace.findFirst({
      where: {
        ownerId: userId,
        isActive: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    if (!workspace) {
      return fillDto(WorkspaceStatusRdo, {
        onboardingComplete: false,
        diagnosticsComplete: false,
        isActive: false,
        canAccessWorkspace: false,
      });
    }

    const canAccess =
      workspace.onboardingComplete && workspace.diagnosticsComplete;

    return fillDto(WorkspaceStatusRdo, {
      onboardingComplete: workspace.onboardingComplete,
      diagnosticsComplete: workspace.diagnosticsComplete,
      isActive: workspace.isActive,
      canAccessWorkspace: canAccess,
    });
  }

  private validateOnboardingDto(dto: CompleteOnboardingDto): void {
    if (dto.industry === "Другое" && !dto.industryOther?.trim()) {
      throw new BadRequestException(
        "Опишите, чем занимается компания — вы выбрали «Другое».",
      );
    }

    if (dto.ownerRole === "Другое" && !dto.roleOther?.trim()) {
      throw new BadRequestException(
        "Укажите вашу должность — вы выбрали «Другое».",
      );
    }

    // Проверяем, что хотя бы один приоритет заполнен
    const priorities = [dto.priority1, dto.priority2, dto.priority3].filter(
      (p) => p?.trim(),
    );

    if (priorities.length === 0) {
      throw new BadRequestException(
        "Добавьте хотя бы один приоритет.",
      );
    }
  }
}