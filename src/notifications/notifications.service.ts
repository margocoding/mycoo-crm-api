import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { DepartmentRole, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

type Assignee = { email: string; departmentId: string; userId: string | null };
const roleNames = { CHIEF: 'Руководитель', ADMIN: 'Администратор', WORKER: 'Сотрудник' };

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  private async access(userId: string, workspaceId: string) {
    const workspace = await this.prisma.workspace.findFirst({ where: { id: workspaceId,
      OR: [{ ownerId: userId }, { members: { some: { userId } } }] }, select: { ownerId: true } });
    if (!workspace) throw new NotFoundException('Компания не найдена.');
    return workspace;
  }

  async list(userId: string, workspaceId: string, cursor?: string) {
    const workspace = await this.access(userId, workspaceId);
    if (cursor !== undefined && (typeof cursor !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(cursor)))
      throw new BadRequestException('Некорректная страница уведомлений.');
    const where = { workspaceId, recipientId: userId };
    const after = cursor ? await this.prisma.notification.findFirst({ where: { ...where, id: cursor } }) : null;
    if (cursor && !after) throw new BadRequestException('Страница уведомлений недоступна. Обновите ленту.');
    const [rows, unreadCount, departments] = await Promise.all([
      this.prisma.notification.findMany({ where: { ...where, ...(after ? { OR: [
        { createdAt: { lt: after.createdAt } }, { createdAt: after.createdAt, id: { lt: after.id } },
      ] } : {}) }, take: 21, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { task: { select: { departments: { select: { departmentId: true } },
        assignees: { where: { userId }, select: { departmentId: true } } } } } }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
      this.prisma.department.findMany({ where: { workspaceId,
        ...(workspace.ownerId === userId ? {} : { members: { some: { userId } } }) },
        select: { id: true, members: { where: { userId }, select: { role: true } } } }),
    ]);
    const available = new Map(departments.map(d => [d.id, workspace.ownerId === userId || d.members.some(m => m.role !== 'WORKER')]));
    const items = rows.slice(0, 20).map(({ task, ...item }) => {
      const department = task?.departments.find(d => available.has(d.departmentId) &&
        (available.get(d.departmentId) || task.assignees.some(a => a.departmentId === d.departmentId)));
      const href = item.kind === 'TASK_ASSIGNED' ? (department ? '/dashboard/tasks/' + department.departmentId : null)
        : item.departmentId && available.has(item.departmentId) ? '/dashboard/team/' + item.departmentId : null;
      return { id: item.id, kind: item.kind, message: item.message, readAt: item.readAt, createdAt: item.createdAt, href };
    });
    return { items, unreadCount, nextCursor: rows.length > 20 ? items[items.length - 1].id : null };
  }

  async read(userId: string, workspaceId: string, id: string) {
    await this.access(userId, workspaceId);
    const where = { id, workspaceId, recipientId: userId };
    if (!await this.prisma.notification.findFirst({ where, select: { id: true } }))
      throw new NotFoundException('Уведомление не найдено.');
    await this.prisma.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: new Date() } });
    return { success: true };
  }

  async readAll(userId: string, workspaceId: string) {
    const now = new Date();
    await this.access(userId, workspaceId);
    await this.prisma.notification.updateMany({ where: { workspaceId, recipientId: userId, readAt: null,
      createdAt: { lte: now } }, data: { readAt: now } });
    return { success: true };
  }

  async roleChanged(tx: Prisma.TransactionClient, departmentId: string, recipientIds: string[], role: DepartmentRole) {
    if (!recipientIds.length) return;
    const department = await tx.department.findUniqueOrThrow({ where: { id: departmentId }, select: { name: true, workspaceId: true } });
    await tx.notification.createMany({ data: [...new Set(recipientIds)].map(recipientId => ({
      workspaceId: department.workspaceId, recipientId, kind: 'ROLE_CHANGED', departmentId, createdAt: new Date(),
      message: `В департаменте «${department.name}» ваша роль изменена на «${roleNames[role]}».`,
    })) });
  }

  async assigned(tx: Prisma.TransactionClient, task: { id: string; workspaceId: string; title: string; assignees: Assignee[] }, previous: Assignee[] = []) {
    const before = new Set(previous.map(a => `${a.departmentId}:${a.email}`));
    const recipients = new Map<string, string>();
    for (const a of task.assignees) if (a.userId && !before.has(`${a.departmentId}:${a.email}`)) recipients.set(a.userId, a.departmentId);
    if (!recipients.size) return;
    await tx.notification.createMany({ data: [...recipients].map(([recipientId, departmentId]) => ({
      workspaceId: task.workspaceId, recipientId, departmentId, taskId: task.id, kind: 'TASK_ASSIGNED',
      message: `Вам назначена задача «${task.title}».`, createdAt: new Date(),
    })) });
  }

  async bindPending(tx: Prisma.TransactionClient, email: string, userId: string, name: string | null, departmentIds: string[]) {
    if (!departmentIds.length) return;
    const where = { email, userId: null, departmentId: { in: departmentIds } };
    const assignments = await tx.taskAssignee.findMany({ where, include: { task: true } });
    await tx.taskAssignee.updateMany({ where, data: { userId, name } });
    const tasks = new Map(assignments.map(a => [a.taskId, a.task]));
    for (const task of tasks.values()) await this.assigned(tx, { ...task,
      assignees: assignments.filter(a => a.taskId === task.id).map(a => ({ ...a, userId })) });
  }
}
