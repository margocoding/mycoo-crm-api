import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { TasksService } from './tasks.service.js';
import type { TeamService } from '../team/team.service.js';
import type { DashboardService } from '../dashboard/dashboard.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';

function fixture(status = 'review', canManage = true) {
  const task = { id: 'task', status, startDate: new Date('2026-09-21'), dueDate: new Date('2026-09-25'),
    assignees: [], departments: ['sales', 'support'].map(departmentId => ({ departmentId, department: { id: departmentId } })) };
  const tx = { task: { findFirst: vi.fn().mockResolvedValue(task),
    update: vi.fn().mockImplementation(({ data }) => Promise.resolve({ ...task, ...data })) } };
  const events: string[] = [];
  const team = { transaction: vi.fn(async (_id, action) => { const result = await action(tx); events.push('commit'); return result; }),
    departmentAccess: vi.fn().mockResolvedValue({ workspace: { id: 'company' }, department: { id: 'sales' }, isOwner: canManage, canManage }) };
  const dashboard = { requestRefresh: vi.fn(async () => { events.push('request'); return ['company', 'sales', 'support']; }),
    enqueue: vi.fn(async () => { events.push('enqueue'); }) };
  return { tx, team, dashboard, events,
    service: new TasksService(team as unknown as TeamService, dashboard as unknown as DashboardService, {} as NotificationsService) };
}

describe('Completed tasks and dashboard refresh', () => {
  it('persists company and all shared department requests in the task transaction, then enqueues after commit', async () => {
    const f = fixture();
    await f.service.setStatus('owner', 'company', 'sales', 'task', 'done');
    expect(f.dashboard.requestRefresh).toHaveBeenCalledWith(f.tx, 'company', ['sales', 'support']);
    expect(f.events).toEqual(['request', 'commit', 'enqueue']);
  });
  it.each(['done', 'in-progress'])('does not request inference for a no-op or a non-completion: %s', async status => {
    const f = fixture(status === 'done' ? 'done' : 'review');
    await f.service.setStatus('owner', 'company', 'sales', 'task', status as 'done' | 'in-progress');
    expect(f.dashboard.requestRefresh).not.toHaveBeenCalled();
    expect(f.dashboard.enqueue).toHaveBeenCalledWith([]);
  });
  it('rejects employee completion before changing the task or enqueuing analysis', async () => {
    const f = fixture('review', false);
    await expect(f.service.setStatus('worker', 'company', 'sales', 'task', 'done')).rejects.toThrow('Статус');
    expect(f.tx.task.update).not.toHaveBeenCalled();
    expect(f.dashboard.enqueue).not.toHaveBeenCalled();
  });
  it('does not publish a refresh if the task transaction fails', async () => {
    const f = fixture();
    f.team.transaction.mockRejectedValueOnce(new Error('transaction failed'));
    await expect(f.service.setStatus('owner', 'company', 'sales', 'task', 'done')).rejects.toThrow('transaction failed');
    expect(f.dashboard.enqueue).not.toHaveBeenCalled();
  });
});
