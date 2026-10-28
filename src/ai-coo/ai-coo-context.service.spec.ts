import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TeamService } from '../team/team.service.js';
import { AiCooContextService } from './ai-coo-context.service.js';

const now = new Date('2026-10-26T21:30:00Z'); // 27 October in Moscow.
const department = (id: string, canManage = true) => ({ id, name: `Department ${id}`, canManage });
const analysis = (recommendation: string) => ({ goalProgress: 40, goalExplanation: 'Часть плана выполнена.', risks: [], recommendation });
const assignee = (userId: string | null, departmentId: string, name: string) => ({
  id: `${departmentId}:${userId || name}`, userId, departmentId, name, user: userId ? { name } : null,
  email: `${userId}@private.test`,
});
const task = (id: string, overrides: Record<string, any> = {}) => ({
  id, workspaceId: 'workspace', title: `Task ${id}`, status: 'in-progress', priority: 'medium',
  createdById: 'owner', createdAt: new Date('2026-10-22T12:00Z'), updatedAt: new Date('2026-10-22T12:00Z'),
  startDate: new Date('2026-10-21'), dueDate: new Date('2026-10-28'), successCriteria: 'Проверить результат',
  departments: [{ departmentId: 'a', department: { name: 'Department a' } }],
  assignees: [assignee('worker', 'a', 'Иван')], ...overrides,
});

// A small predicate-backed repository fixture exercises the actual ORM access
// predicates against mixed-tenant rows, instead of returning prefiltered answers.
function matches(row: Record<string, any>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'AND') return (Array.isArray(condition) ? condition : [condition]).every(item => matches(row, item));
    if (key === 'OR') return condition.some((item: Record<string, any>) => matches(row, item));
    const value = row[key];
    if (condition === null || typeof condition !== 'object' || condition instanceof Date) return value === condition;
    if ('some' in condition) return value.some((item: Record<string, any>) => matches(item, condition.some));
    return Object.entries(condition).every(([operator, expected]) => {
      if (operator === 'not') return value !== expected;
      if (operator === 'gte') return value >= expected!;
      if (operator === 'gt') return value > expected!;
      if (operator === 'lte') return value <= expected!;
      if (operator === 'lt') return value < expected!;
      throw new Error(`Unsupported fixture predicate ${operator}`);
    });
  });
}

function fixture(rows = [task('a')], owner = false) {
  const teamData = { workspaceId: 'workspace', isOwner: owner,
    departments: owner ? [department('a'), department('b')] : [department('a')], members: [], invitations: [] };
  const team = { getTeam: vi.fn(async (userId: string, workspaceId: string) => {
    if (workspaceId !== 'workspace' || userId === 'outsider') throw new NotFoundException();
    return teamData;
  }) };
  const workspace = {
    company: 'Test company', industry: 'other', industryOther: 'Производство', goal: 'Снизить задержки',
    priority1: 'Сроки', priority2: null, priority3: '', revenue: 'Private revenue',
    problem: 'Private company problem', employees: '100+', managers: '5', stage: 'Рост',
  };
  const snapshots: any[] = [
    { scopeKey: 'workspace:company', workspaceId: 'workspace', departmentId: null,
      analysis: analysis('Company-only analysis'), generatedAt: new Date(now.getTime() - 60_000),
      periodStart: new Date('2026-10-21'), periodEnd: new Date('2026-10-27') },
    { scopeKey: 'workspace:a', workspaceId: 'workspace', departmentId: 'a',
      analysis: analysis('Department a analysis'), generatedAt: new Date(now.getTime() - 60_000),
      periodStart: new Date('2026-10-21'), periodEnd: new Date('2026-10-27') },
    { scopeKey: 'other:a', workspaceId: 'other', departmentId: 'a',
      analysis: analysis('Other company secret'), generatedAt: now, periodStart: now, periodEnd: now },
  ];
  const prisma = {
    workspace: { findUnique: vi.fn(async () => workspace) },
    task: {
      groupBy: vi.fn(async ({ where }: any) => {
        const counts = new Map<string, number>();
        rows.filter(row => matches(row, where)).forEach(row => counts.set(row.status, (counts.get(row.status) || 0) + 1));
        return [...counts].map(([status, count]) => ({ status, _count: { _all: count } }));
      }),
      count: vi.fn(async ({ where }: any) => rows.filter(row => matches(row, where)).length),
      findMany: vi.fn(async ({ where, take, select }: any) => rows.filter(row => matches(row, where))
        .sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.id.localeCompare(b.id)).slice(0, take)
        .map(row => ({ ...row,
          _count: { assignees: row.assignees.filter((item: any) => matches(item, select._count.select.assignees.where)).length },
        }))),
    },
    dashboardSnapshot: { findFirst: vi.fn(async ({ where }: any) => snapshots.find(row => matches(row, where)) ?? null) },
  };
  return { prisma, team, teamData, workspace, snapshots,
    service: new AiCooContextService(prisma as unknown as PrismaService, team as unknown as TeamService) };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe('AI COO context access', () => {
  it('gives the owner company context but never another tenant, even with the same department identifier', async () => {
    const f = fixture([task('a'), task('b', { departments: [{ departmentId: 'b', department: { name: 'Department b' } }] }),
      task('foreign', { workspaceId: 'other', title: 'Other company secret' })], true);
    const result = await f.service.build('owner', 'workspace');
    expect(result.scopeKey).toBe('company');
    expect(result.summary.tasks.total).toBe(2);
    expect(result.prompt.examples.map(item => item.id)).toEqual(['a', 'b']);
    expect(result.prompt.ownerBrief?.revenue).toBe('Private revenue');
    expect(result.summary.dashboard.analysis?.recommendation).toBe('Company-only analysis');
    expect(JSON.stringify(result)).not.toContain('Other company secret');
    expect(JSON.stringify(result)).not.toContain('@private.test');
    expect(result.scopes.map(item => item.id)).toEqual(['', 'a', 'b']);
  });

  it('restricts a department manager to that department, including shared task people and cached analysis', async () => {
    const shared = task('shared', {
      departments: [{ departmentId: 'a', department: { name: 'Department a' } },
        { departmentId: 'b', department: { name: 'Hidden department' } }],
      assignees: [assignee('worker', 'a', 'Иван'), assignee('hidden', 'b', 'Hidden person')],
    });
    const f = fixture([shared, task('other-department', { title: 'Hidden task',
      departments: [{ departmentId: 'b', department: { name: 'Hidden department' } }] })]);
    const result = await f.service.build('chief', 'workspace', 'a');
    expect(result.scopeKey).toBe('department:a');
    expect(result.summary.tasks.total).toBe(1);
    expect(result.prompt.examples[0].assignees).toEqual([{ name: 'Иван', invited: false }]);
    expect(result.prompt.examples[0].assigneeCount).toBe(1);
    expect(result.prompt.ownerBrief).toBeUndefined();
    expect(result.summary.dashboard.analysis?.recommendation).toBe('Department a analysis');
    expect(f.prisma.workspace.findUnique.mock.calls[0]).toEqual([{ where: { id: 'workspace' }, select: {
      company: true, industry: true, industryOther: true, goal: true, priority1: true, priority2: true, priority3: true,
    } }]);
    expect(f.prisma.dashboardSnapshot.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { workspaceId: 'workspace', departmentId: 'a', scopeKey: 'workspace:a' },
    }));
    for (const hidden of ['Hidden person', 'Hidden task', 'Hidden department', 'Company-only analysis', 'Private revenue']) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });

  it('shows an employee only their own assignments or created tasks and never the department AI summary', async () => {
    const f = fixture([
      task('assigned', { assignees: [assignee('worker', 'a', 'Иван'), assignee('coworker', 'a', 'Colleague')] }),
      task('created', { createdById: 'worker', assignees: [assignee('coworker', 'a', 'Colleague')] }),
      task('colleague', { assignees: [assignee('coworker', 'a', 'Colleague')] }),
      task('outside', { createdById: 'worker', departments: [{ departmentId: 'b', department: { name: 'Hidden department' } }] }),
    ]);
    f.teamData.departments = [department('a', false)];
    const result = await f.service.build('worker', 'workspace', 'a');
    expect(result.scopeKey).toBe('personal:a');
    expect(result.scope.personal).toBe(true);
    expect(result.prompt.examples.map(item => item.id)).toEqual(['assigned', 'created']);
    expect(result.summary.tasks.total).toBe(2);
    expect(result.summary.dashboard).toEqual({ status: 'restricted', generatedAt: null, analysis: null });
    expect(f.prisma.dashboardSnapshot.findFirst).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('Colleague');
    expect(result.prompt.examples[1].assigneeCount).toBe(0);
  });

  it('rejects inaccessible departments and revoked membership before reading task data', async () => {
    const f = fixture();
    await expect(f.service.build('chief', 'workspace', 'b')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(f.service.build('outsider', 'workspace', 'a')).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.build('chief', 'other', 'a')).rejects.toBeInstanceOf(NotFoundException);
    f.teamData.departments = [];
    await expect(f.service.build('chief', 'workspace')).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.prisma.task.findMany).not.toHaveBeenCalled();
  });

  it('changes conversation scope after demotion, so old management history is not reused', async () => {
    const f = fixture();
    expect((await f.service.build('worker', 'workspace')).scopeKey).toBe('department:a');
    f.teamData.departments = [department('a', false)];
    const demoted = await f.service.build('worker', 'workspace');
    expect(demoted.scopeKey).toBe('personal:a');
    expect(demoted.summary.dashboard.status).toBe('restricted');
    expect(f.team.getTeam).toHaveBeenCalledTimes(2);
  });

  it('keeps owner-selected department analysis local to the selected department', async () => {
    const f = fixture([task('a')], true);
    const result = await f.service.build('owner', 'workspace', 'a');
    expect(result.scopeKey).toBe('department:a');
    expect(result.prompt.ownerBrief).toBeUndefined();
    expect(result.summary.dashboard.analysis?.recommendation).toBe('Department a analysis');
  });
});

describe('AI COO context reporting', () => {
  it('uses Moscow week boundaries, scheduled overlap and exact scoped counters; old overdue tasks remain in current totals', async () => {
    const old = { createdAt: new Date('2026-09-01'), updatedAt: new Date('2026-09-01'),
      startDate: new Date('2026-09-01'), dueDate: new Date('2026-09-02') };
    const f = fixture([
      task('boundary', { ...old, createdAt: new Date('2026-10-20T21:00:00Z') }),
      task('before', { ...old, createdAt: new Date('2026-10-20T20:59:59.999Z') }),
      task('after', { ...old, createdAt: new Date('2026-10-27T21:00:00Z') }),
      task('overlap', { ...old, status: 'done', dueDate: new Date('2026-10-21') }),
      task('updated', { ...old, updatedAt: new Date('2026-10-27T12:00:00Z') }),
    ], true);
    const result = await f.service.build('owner', 'workspace');
    expect(result.summary.periodStart).toBe('2026-10-21');
    expect(result.summary.periodEnd).toBe('2026-10-27');
    expect(result.prompt.examples.map(item => item.id).sort()).toEqual(['boundary', 'overlap', 'updated']);
    expect(result.summary.tasks).toEqual({ total: 3, included: 3, active: 2, completed: 1, overdue: 2 });
    expect(result.prompt.current).toEqual({ active: 4, overdue: 4 });
    expect(result.prompt.week.statuses).toEqual({ 'in-progress': 2, done: 1 });
  });

  it('bounds large context without deriving total counts from the examples', async () => {
    const rows = Array.from({ length: 120 }, (_, index) => task(`t${String(index).padStart(3, '0')}`, {
      title: 'Длинное название '.repeat(100), successCriteria: 'Критерий '.repeat(500),
      assignees: Array.from({ length: 5 }, (_, person) => assignee(`p${person}`, 'a', 'Очень длинное имя '.repeat(50))),
    }));
    const f = fixture(rows, true);
    f.workspace.goal = 'Цель '.repeat(3000);
    const result = await f.service.build('owner', 'workspace');
    expect(result.summary.tasks.total).toBe(120);
    expect(result.summary.tasks.included).toBeGreaterThan(0);
    expect(result.summary.tasks.included).toBeLessThan(80);
    expect(result.prompt.week.omitted).toBe(120 - result.summary.tasks.included);
    expect(JSON.stringify(result.prompt).length).toBeLessThanOrEqual(36_000);
    expect(result.prompt.company.goal!.length).toBeLessThanOrEqual(1500);
    expect(result.prompt.examples[0].title.length).toBeLessThanOrEqual(180);
    expect(result.prompt.examples[0].criteria.length).toBeLessThanOrEqual(250);
    expect(result.prompt.examples[0].assignees[0].name.length).toBeLessThanOrEqual(60);
    expect(f.prisma.task.findMany.mock.calls[0][0].take).toBe(80);
  });

  it('marks old summaries stale and ignores malformed saved model output without inventing a result', async () => {
    const f = fixture();
    f.snapshots[1].generatedAt = new Date(now.getTime() - 86_400_000);
    expect((await f.service.build('chief', 'workspace')).summary.dashboard.status).toBe('stale');
    f.snapshots[1].analysis = { text: 'Unvalidated content' };
    const invalid = await f.service.build('chief', 'workspace');
    expect(invalid.summary.dashboard).toEqual({ status: 'unavailable', analysis: null, generatedAt: null });
    expect(JSON.stringify(invalid.prompt)).not.toContain('Unvalidated content');
    f.snapshots.splice(1, 1);
    expect((await f.service.build('chief', 'workspace')).summary.dashboard.status).toBe('unavailable');
  });
});
