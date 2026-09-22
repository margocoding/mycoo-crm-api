import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { DashboardSnapshot, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TeamService } from '../team/team.service.js';
import { GigachatService } from '../gigachat/gigachat.service.js';
import { parseDashboardAnalysis } from '../gigachat/dashboard-analysis.js';
import { DashboardQueue } from './dashboard.queue.js';

const DAY = 86_400_000;
const RETRY = 15 * 60_000;
const MAX_EXAMPLES = 80;

export function dashboardPeriod(now = new Date()) {
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(now);
  const end = new Date(today);
  const start = new Date(end.getTime() - 6 * DAY);
  return { start, end, since: new Date(start.getTime() - 3 * 3_600_000),
    until: new Date(end.getTime() + DAY - 3 * 3_600_000) };
}

@Injectable()
export class DashboardService implements OnModuleInit {
  private readonly logger = new Logger(DashboardService.name);

  constructor(private readonly prisma: PrismaService, private readonly team: TeamService,
    private readonly gigachat: GigachatService, private readonly queue: DashboardQueue) {}

  async onModuleInit() {
    await this.queue.start((key, revision) => this.refresh(key, revision), () => this.restoreQueue());
  }

  private leaseExpired(now = new Date()) {
    return new Date(now.getTime() - this.gigachat.totalTimeoutMs - 60_000);
  }

  private taskFilter(workspaceId: string, departmentId?: string | null): Prisma.TaskWhereInput {
    return { workspaceId, ...(departmentId ? { departments: { some: { departmentId } } } : {}) };
  }

  async get(userId: string, workspaceId: string, requestedDepartment?: string) {
    if (requestedDepartment !== undefined && (typeof requestedDepartment !== 'string' || requestedDepartment.length > 128))
      throw new BadRequestException('Некорректный департамент.');
    const team = await this.team.getTeam(userId, workspaceId);
    const departmentId = requestedDepartment || (team.isOwner ? null : team.departments[0]?.id);
    const department = team.departments.find(d => d.id === departmentId);
    if ((departmentId && !department) || (!team.isOwner && !department))
      throw new ForbiddenException('Нет доступа к департаменту.');
    const canAnalyze = team.isOwner || Boolean(department?.canManage);
    const now = new Date();
    const { end: today } = dashboardPeriod(now);
    const where: Prisma.TaskWhereInput = { ...this.taskFilter(workspaceId, departmentId),
      ...(canAnalyze ? {} : { assignees: { some: { userId, departmentId: departmentId! } } }) };
    const [groups, overdue, upcoming, workspace] = await Promise.all([
      this.prisma.task.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.task.count({ where: { ...where, status: { not: 'done' }, dueDate: { lt: today } } }),
      this.prisma.task.findMany({ where: { ...where, status: { not: 'done' } }, take: 3,
        orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, title: true, startDate: true, dueDate: true, status: true,
          departments: { where: departmentId ? { departmentId } : {}, take: 1, orderBy: { departmentId: 'asc' }, select: { departmentId: true } } } }),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { isActive: true, diagnosticsComplete: true } }),
    ]);
    const members = team.members.filter(m => !m.isOwner && m.departments.some(d => !departmentId || d.id === departmentId));
    let ai: ReturnType<DashboardService['presentSnapshot']> = { status: canAnalyze ? 'unavailable' : 'restricted',
      analysis: null, generatedAt: null, periodStart: null, periodEnd: null, nextRefreshAt: null };
    if (canAnalyze && workspace.isActive && workspace.diagnosticsComplete) {
      const scopeKey = `${workspaceId}:${departmentId || 'company'}`;
      const snapshot = await this.prisma.dashboardSnapshot.upsert({ where: { scopeKey }, update: {},
        create: { scopeKey, workspaceId, departmentId, nextRefreshAt: now } });
      ai = this.presentSnapshot(snapshot, now);
      if (snapshot.nextRefreshAt <= now && (!snapshot.processingAt || snapshot.processingAt <= this.leaseExpired(now))) {
        ai.status = 'updating';
      }
      await this.enqueue([scopeKey]);
    }
    return {
      scope: { departmentId: departmentId ?? null, name: department?.name ?? 'Вся компания', personal: !canAnalyze },
      scopes: [...(team.isOwner ? [{ id: '', name: 'Вся компания' }] : []), ...team.departments.map(d => ({ id: d.id, name: d.name }))],
      tasks: { active: groups.filter(g => g.status !== 'done').reduce((sum, g) => sum + g._count._all, 0),
        overdue, completed: groups.find(g => g.status === 'done')?._count._all ?? 0,
        items: upcoming.map(t => ({ id: t.id, title: t.title, status: t.status,
          startDate: t.startDate.toISOString().slice(0, 10), dueDate: t.dueDate.toISOString().slice(0, 10),
          departmentId: t.departments[0]?.departmentId ?? null })) },
      team: { employees: members.length, managers: members.filter(m => m.departments.some(d =>
        (!departmentId || d.id === departmentId) && d.role === 'CHIEF')).length },
      ai, updatedAt: now.toISOString(), today: today.toISOString().slice(0, 10),
    };
  }

  private presentSnapshot(snapshot: DashboardSnapshot, now: Date) {
    return {
      status: snapshot.processingAt && snapshot.processingAt > this.leaseExpired(now) ? 'updating'
        : !snapshot.generatedAt ? 'unavailable' : snapshot.generatedAt.getTime() + DAY <= now.getTime() ? 'stale' : 'ready',
      analysis: snapshot.analysis ? parseDashboardAnalysis(JSON.stringify(snapshot.analysis)) : null,
      generatedAt: snapshot.generatedAt?.toISOString() ?? null,
      periodStart: snapshot.periodStart?.toISOString().slice(0, 10) ?? null,
      periodEnd: snapshot.periodEnd?.toISOString().slice(0, 10) ?? null,
      nextRefreshAt: snapshot.nextRefreshAt.toISOString() as string | null,
    };
  }

  async requestRefresh(tx: Prisma.TransactionClient, workspaceId: string, departmentIds: string[]) {
    const keys: string[] = [];
    for (const departmentId of [null, ...new Set(departmentIds)]) {
      const scopeKey = `${workspaceId}:${departmentId || 'company'}`;
      await tx.dashboardSnapshot.upsert({ where: { scopeKey },
        create: { scopeKey, workspaceId, departmentId, revision: 1, nextRefreshAt: new Date() },
        update: { revision: { increment: 1 }, nextRefreshAt: new Date() } });
      keys.push(scopeKey);
    }
    return keys;
  }

  async enqueue(keys: string[]) {
    try { for (const key of keys) await this.scheduleCurrent(key); }
    catch { this.logger.warn('Dashboard request saved; queue will recover on reconnect or restart'); }
  }

  private async scheduleCurrent(scopeKey: string) {
    const snapshot = await this.prisma.dashboardSnapshot.findFirst({ where: {
      scopeKey, workspace: { isActive: true, diagnosticsComplete: true },
    } });
    if (!snapshot) return;
    const at = Math.max(snapshot.nextRefreshAt.getTime(), snapshot.processingAt
      ? snapshot.processingAt.getTime() + this.gigachat.totalTimeoutMs + 60_000 : 0);
    await this.queue.schedule(scopeKey, snapshot.revision, new Date(at));
  }

  private async restoreQueue() {
    let cursor: string | undefined;
    for (;;) {
      const snapshots = await this.prisma.dashboardSnapshot.findMany({
        where: { workspace: { isActive: true, diagnosticsComplete: true } },
        orderBy: { scopeKey: 'asc' }, take: 100,
        ...(cursor ? { cursor: { scopeKey: cursor }, skip: 1 } : {}), select: { scopeKey: true },
      });
      for (const snapshot of snapshots) await this.scheduleCurrent(snapshot.scopeKey);
      if (snapshots.length < 100) return;
      cursor = snapshots[snapshots.length - 1].scopeKey;
    }
  }

  async refresh(scopeKey: string, revision: number) {
    const processingAt = new Date();
    const claimed = await this.prisma.dashboardSnapshot.updateMany({ where: {
      scopeKey, revision, nextRefreshAt: { lte: processingAt }, workspace: { isActive: true, diagnosticsComplete: true },
      OR: [{ processingAt: null }, { processingAt: { lte: this.leaseExpired(processingAt) } }],
    }, data: { processingAt } });
    if (!claimed.count) { await this.scheduleCurrent(scopeKey); return; }
    try {
      const snapshot = await this.prisma.dashboardSnapshot.findUniqueOrThrow({ where: { scopeKey },
        include: { workspace: true, department: true } });
      const { context, period } = await this.context(snapshot);
      const analysis = await this.gigachat.analyzeDashboard(context);
      if (!context.goal || context.week.total === 0) {
        analysis.goalProgress = null;
        analysis.goalExplanation = !context.goal ? 'Укажите цель компании для оценки прогресса.' : 'За последние 7 дней нет задач для оценки прогресса.';
      }
      const generatedAt = new Date();
      await this.prisma.dashboardSnapshot.updateMany({ where: { scopeKey, processingAt, revision }, data: {
        analysis: { ...analysis }, generatedAt, processingAt: null, periodStart: period.start, periodEnd: period.end,
        nextRefreshAt: new Date(generatedAt.getTime() + DAY),
      } });
    } catch {
      this.logger.warn('Dashboard analysis unavailable; keeping previous result');
      await this.prisma.dashboardSnapshot.updateMany({ where: { scopeKey, processingAt, revision }, data: {
        processingAt: null, nextRefreshAt: new Date(Date.now() + RETRY),
      } });
    } finally {
      // A completion during inference invalidates that result; its newer request stays due.
      await this.prisma.dashboardSnapshot.updateMany({ where: { scopeKey, processingAt }, data: { processingAt: null } });
      await this.scheduleCurrent(scopeKey);
    }
  }

  private async context(snapshot: Prisma.DashboardSnapshotGetPayload<{ include: { workspace: true; department: true } }>) {
    const period = dashboardPeriod();
    const base = this.taskFilter(snapshot.workspaceId, snapshot.departmentId);
    const week: Prisma.TaskWhereInput = { ...base, OR: [
      { createdAt: { gte: period.since, lt: period.until } },
      { updatedAt: { gte: period.since, lt: period.until } },
      { startDate: { lte: period.end }, dueDate: { gte: period.start } },
    ] };
    const [weeklyCounts, currentCounts, overdue, examples, departments] = await Promise.all([
      this.prisma.task.groupBy({ by: ['status'], where: week, _count: { _all: true } }),
      this.prisma.task.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      this.prisma.task.count({ where: { ...base, status: { not: 'done' }, dueDate: { lt: period.end } } }),
      this.prisma.task.findMany({ where: week, orderBy: [{ dueDate: 'asc' }, { id: 'asc' }], take: MAX_EXAMPLES,
        select: { title: true, status: true, priority: true, startDate: true, dueDate: true, successCriteria: true,
          _count: { select: { assignees: { where: snapshot.departmentId ? { departmentId: snapshot.departmentId } : {} } } },
          assignees: { where: snapshot.departmentId ? { departmentId: snapshot.departmentId } : {}, take: 5,
            select: { user: { select: { name: true } }, departmentId: true } } } }),
      this.prisma.department.findMany({ where: { workspaceId: snapshot.workspaceId, ...(snapshot.departmentId ? { id: snapshot.departmentId } : {}) },
        take: 50, orderBy: { createdAt: 'asc' },
        select: { id: true, name: true, _count: { select: { members: true, tasks: { where: { task: week } } } } } }),
    ]);
    const totals = (groups: typeof weeklyCounts) => Object.fromEntries(groups.map(g => [g.status, g._count._all]));
    const total = weeklyCounts.reduce((sum, g) => sum + g._count._all, 0);
    const { workspace } = snapshot;
    return { period, context: {
      scope: snapshot.department?.name ?? 'Вся компания', goal: workspace.goal,
      priorities: [workspace.priority1, workspace.priority2, workspace.priority3].filter(Boolean),
      industry: workspace.industry, periodStart: period.start.toISOString().slice(0, 10), periodEnd: period.end.toISOString().slice(0, 10),
      current: { active: currentCounts.filter(g => g.status !== 'done').reduce((sum, g) => sum + g._count._all, 0), overdue },
      week: { total, statuses: totals(weeklyCounts), examplesLimited: total > MAX_EXAMPLES },
      departmentExamples: departments.map(d => ({ name: d.name, members: d._count.members, weekTasks: d._count.tasks })),
      examples: examples.map(t => ({ title: t.title.slice(0, 160), status: t.status, priority: t.priority,
        start: t.startDate.toISOString().slice(0, 10), due: t.dueDate.toISOString().slice(0, 10),
        criteria: t.successCriteria.slice(0, 300),
        assigneeCount: t._count.assignees,
        assigneeExamples: t.assignees.map(a => ({ name: a.user?.name?.slice(0, 80) ?? 'Приглашённый участник',
          department: departments.find(d => d.id === a.departmentId)?.name })) })),
    } };
  }
}
