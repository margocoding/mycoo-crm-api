import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { dashboardPeriod } from '../dashboard/dashboard.service.js';
import { parseDashboardAnalysis, type DashboardAnalysis } from '../gigachat/dashboard-analysis.js';
import { TeamService } from '../team/team.service.js';

const DAY = 86_400_000;
const MAX_EXAMPLES = 80;
const MAX_PROMPT_CHARS = 36_000;
const clip = (text: string | null | undefined, max: number) => text?.trim().slice(0, max) || null;
const date = (value: Date) => value.toISOString().slice(0, 10);

export interface AiCooContextSummary {
  company: { name: string | null; industry: string | null; goal: string | null; priorities: string[] };
  periodStart: string;
  periodEnd: string;
  tasks: { total: number; included: number; active: number; completed: number; overdue: number };
  dashboard: {
    status: 'restricted' | 'unavailable' | 'stale' | 'ready';
    generatedAt: string | null;
    analysis: DashboardAnalysis | null;
  };
}

export interface AiCooScope {
  departmentId: string | null;
  name: string;
  personal: boolean;
}

export interface AiCooContext {
  scopeKey: string;
  scope: AiCooScope;
  scopes: Array<{ id: string; name: string }>;
  summary: AiCooContextSummary;
  prompt: {
    scope: AiCooScope;
    company: AiCooContextSummary['company'];
    ownerBrief?: { problem: string | null; revenue: string | null; employees: string | null; managers: string | null; stage: string | null };
    periodStart: string;
    periodEnd: string;
    timezone: 'Europe/Moscow';
    generatedAt: string;
    selection: string;
    week: AiCooContextSummary['tasks'] & { omitted: number; statuses: Record<string, number> };
    current: { active: number; overdue: number };
    dashboard: AiCooContextSummary['dashboard'] & { periodStart: string | null; periodEnd: string | null };
    examples: Array<{
      id: string; title: string; status: string; priority: string;
      startDate: string; dueDate: string; criteria: string;
      departments: string[]; assigneeCount: number;
      assignees: Array<{ name: string; invited: boolean }>;
    }>;
    textMayBeTruncated: true;
  };
}

@Injectable()
export class AiCooContextService {
  constructor(private readonly prisma: PrismaService, private readonly team: TeamService) {}

  async build(userId: string, workspaceId: string, requestedDepartment?: string): Promise<AiCooContext> {
    if (requestedDepartment !== undefined && (typeof requestedDepartment !== 'string' || requestedDepartment.length > 128)) {
      throw new BadRequestException('Некорректный департамент.');
    }
    // getTeam checks current workspace membership and returns only accessible departments.
    const team = await this.team.getTeam(userId, workspaceId);
    const departmentId = requestedDepartment || (team.isOwner ? null : team.departments[0]?.id);
    const department = team.departments.find(item => item.id === departmentId);
    if ((departmentId && !department) || (!team.isOwner && !department)) {
      throw new ForbiddenException('Нет доступа к департаменту.');
    }
    const canAnalyze = team.isOwner || Boolean(department?.canManage);
    const personal = !canAnalyze;
    const scope: AiCooScope = {
      departmentId: departmentId ?? null,
      name: department ? (personal ? `Мои задачи · ${department.name}` : department.name) : 'Вся компания',
      personal,
    };
    const scopeKey = departmentId ? `${personal ? 'personal' : 'department'}:${departmentId}` : 'company';
    const now = new Date();
    const period = dashboardPeriod(now);
    const base: Prisma.TaskWhereInput = {
      workspaceId,
      ...(departmentId ? { departments: { some: { departmentId } } } : {}),
      ...(personal ? { OR: [
        { assignees: { some: { userId, departmentId: departmentId! } } },
        { createdById: userId },
      ] } : {}),
    };
    // Match the dashboard's week: newly created/updated tasks and scheduled intervals
    // overlapping the seven Moscow calendar days. Keep old overdue counts separately.
    const week: Prisma.TaskWhereInput = { AND: [base, { OR: [
      { createdAt: { gte: period.since, lt: period.until } },
      { updatedAt: { gte: period.since, lt: period.until } },
      { startDate: { lte: period.end }, dueDate: { gte: period.start } },
    ] }] };
    const assigneeWhere: Prisma.TaskAssigneeWhereInput = {
      ...(departmentId ? { departmentId } : {}), ...(personal ? { userId } : {}),
    };
    const [workspace, groups, overdue, currentActive, currentOverdue, tasks, snapshot] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: {
        company: true, industry: true, industryOther: true, goal: true,
        priority1: true, priority2: true, priority3: true,
        ...(team.isOwner && !departmentId ? { problem: true, revenue: true, employees: true, managers: true, stage: true } : {}),
      } }),
      this.prisma.task.groupBy({ by: ['status'], where: week, _count: { _all: true } }),
      this.prisma.task.count({ where: { AND: [week, { status: { not: 'done' }, dueDate: { lt: period.end } }] } }),
      this.prisma.task.count({ where: { AND: [base, { status: { not: 'done' } }] } }),
      this.prisma.task.count({ where: { AND: [base, { status: { not: 'done' }, dueDate: { lt: period.end } }] } }),
      this.prisma.task.findMany({ where: week, take: MAX_EXAMPLES,
        orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
        select: {
          id: true, title: true, status: true, priority: true, startDate: true, dueDate: true, successCriteria: true,
          departments: { where: departmentId ? { departmentId } : {}, take: 5,
            orderBy: { departmentId: 'asc' }, select: { departmentId: true, department: { select: { name: true } } } },
          _count: { select: { assignees: { where: assigneeWhere } } },
          assignees: { where: assigneeWhere, take: 5, orderBy: { id: 'asc' },
            select: { departmentId: true, userId: true, name: true, user: { select: { name: true } } } },
        },
      }),
      canAnalyze ? this.prisma.dashboardSnapshot.findFirst({ where: {
        workspaceId, departmentId: departmentId ?? null, scopeKey: `${workspaceId}:${departmentId || 'company'}`,
      }, select: { analysis: true, generatedAt: true, periodStart: true, periodEnd: true } }) : Promise.resolve(null),
    ]);
    if (!workspace) throw new NotFoundException('Компания не найдена.');

    const company: AiCooContextSummary['company'] = {
      name: clip(workspace.company, 200),
      industry: clip(workspace.industry === 'other' ? workspace.industryOther || workspace.industry : workspace.industry, 200),
      goal: clip(workspace.goal, 1500),
      priorities: [workspace.priority1, workspace.priority2, workspace.priority3]
        .map(value => clip(value, 600)).filter((value): value is string => value !== null),
    };
    let analysis: DashboardAnalysis | null = null;
    if (snapshot?.analysis && snapshot.generatedAt) {
      try { analysis = parseDashboardAnalysis(JSON.stringify(snapshot.analysis)); }
      catch { /* A malformed/legacy cached result must not break the chat or reach the model. */ }
    }
    const dashboard: AiCooContextSummary['dashboard'] = {
      status: !canAnalyze ? 'restricted' : !analysis ? 'unavailable'
        : snapshot!.generatedAt!.getTime() + DAY <= now.getTime() ? 'stale' : 'ready',
      generatedAt: analysis ? snapshot!.generatedAt!.toISOString() : null,
      analysis,
    };
    const total = groups.reduce((sum, item) => sum + item._count._all, 0);
    const completed = groups.find(item => item.status === 'done')?._count._all ?? 0;
    const summary: AiCooContextSummary = {
      company, periodStart: date(period.start), periodEnd: date(period.end),
      tasks: { total, included: 0, active: total - completed, completed, overdue }, dashboard,
    };
    const prompt: AiCooContext['prompt'] = {
      scope, company,
      ...(team.isOwner && !departmentId ? { ownerBrief: {
        problem: clip(workspace.problem, 1000), revenue: clip(workspace.revenue, 120),
        employees: clip(workspace.employees, 100), managers: clip(workspace.managers, 100), stage: clip(workspace.stage, 200),
      } } : {}),
      periodStart: summary.periodStart, periodEnd: summary.periodEnd, timezone: 'Europe/Moscow', generatedAt: now.toISOString(),
      selection: 'За 7 календарных дней: задачи, созданные или изменённые в периоде, либо с пересекающим период интервалом выполнения. Счётчики current включают все доступные задачи, в том числе старые просроченные. Статус done означает выполнение; дата его установки отдельно не хранится, completed не равен числу завершённых за неделю. examples — ограниченная выборка, не весь список. Исполнители, их счётчики и отделы ограничены правами пользователя; пустой список видимых исполнителей не доказывает отсутствие назначений.',
      week: { ...summary.tasks, omitted: total, statuses: Object.fromEntries(groups.map(item => [item.status, item._count._all])) },
      current: { active: currentActive, overdue: currentOverdue },
      dashboard: { ...dashboard, periodStart: analysis && snapshot?.periodStart ? date(snapshot.periodStart) : null,
        periodEnd: analysis && snapshot?.periodEnd ? date(snapshot.periodEnd) : null },
      examples: [], textMayBeTruncated: true,
    };
    for (const task of tasks) {
      const example: AiCooContext['prompt']['examples'][number] = {
        id: task.id, title: clip(task.title, 180) ?? '', status: task.status, priority: task.priority,
        startDate: date(task.startDate), dueDate: date(task.dueDate), criteria: clip(task.successCriteria, 250) ?? '',
        departments: task.departments.filter(row => !departmentId || row.departmentId === departmentId)
          .map(row => clip(row.department.name, 60) ?? ''),
        assigneeCount: task._count.assignees,
        assignees: task.assignees.filter(row => (!departmentId || row.departmentId === departmentId) && (!personal || row.userId === userId))
          .map(row => ({ name: clip(row.user?.name || row.name, 60) ?? 'Имя не указано', invited: row.userId === null })),
      };
      prompt.examples.push(example);
      if (JSON.stringify(prompt).length > MAX_PROMPT_CHARS - 100) { prompt.examples.pop(); break; }
    }
    summary.tasks.included = prompt.examples.length;
    prompt.week.included = prompt.examples.length;
    prompt.week.omitted = Math.max(0, total - prompt.examples.length);
    return {
      scopeKey, scope,
      scopes: [...(team.isOwner ? [{ id: '', name: 'Вся компания' }] : []),
        ...team.departments.map(item => ({ id: item.id, name: item.name }))],
      summary, prompt,
    };
  }
}
