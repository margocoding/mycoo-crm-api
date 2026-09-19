import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { TeamService } from '../team/team.service.js';
import type { TaskDto, TaskStatus } from './dto/task.dto.js';

const taskInclude = { assignees: { orderBy: { email: 'asc' as const } } };
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;

@Injectable()
export class TasksService {
  constructor(private readonly team: TeamService) {}

  private present(task: TaskRow, userId: string, canManage: boolean) {
    return {
      ...task, dueDate: task.dueDate.toISOString().slice(0, 10),
      assignees: task.assignees.filter((a) => canManage || a.userId === userId)
        .map(({ email, name, userId }) => ({ email, name, userId })),
    };
  }

  private manager(canManage: boolean) {
    if (!canManage) throw new ForbiddenException('Управление задачами доступно начальнику и администратору.');
  }

  private async assignees(tx: Prisma.TransactionClient, departmentId: string, emails: string[], current: TaskRow['assignees'] = []) {
    const [members, invitations] = await Promise.all([
      tx.departmentMember.findMany({ where: { departmentId, user: { email: { in: emails } } },
        include: { user: { select: { email: true, name: true } } } }),
      tx.teamInvitation.findMany({
        where: { departmentId, email: { in: emails }, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return emails.map((email) => {
      const member = members.find((m) => m.user.email === email);
      if (member) return { email, name: member.user.name, userId: member.userId };
      const invitation = invitations.find((i) => i.email === email);
      if (invitation) return { email, name: invitation.name, userId: null };
      // An expired invitation may remain on an existing task until it is reissued.
      const previous = current.find((a) => a.email === email && !a.userId);
      if (previous) return { email, name: previous.name, userId: null };
      throw new BadRequestException('Исполнители должны состоять в департаменте или иметь действующее приглашение.');
    });
  }

  async list(userId: string, workspaceId: string, departmentId: string) {
    return this.team.transaction(workspaceId, async (tx) => {
      const { canManage } = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      const tasks = await tx.task.findMany({
        where: { departmentId, ...(canManage ? {} : { assignees: { some: { userId } } }) },
        include: taskInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return { canManage, tasks: tasks.map((t) => this.present(t, userId, canManage)) };
    });
  }

  async create(userId: string, workspaceId: string, departmentId: string, dto: TaskDto) {
    return this.team.transaction(workspaceId, async (tx) => {
      const { canManage } = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      this.manager(canManage);
      const { assigneeEmails, dueDate, ...details } = dto;
      const assignees = await this.assignees(tx, departmentId, assigneeEmails);
      const task = await tx.task.create({
        data: { ...details, departmentId, dueDate: new Date(dueDate), assignees: { create: assignees } },
        include: taskInclude,
      });
      return this.present(task, userId, true);
    });
  }

  private async find(tx: Prisma.TransactionClient, departmentId: string, id: string, userId: string, canManage: boolean) {
    const task = await tx.task.findFirst({
      where: { id, departmentId, ...(canManage ? {} : { assignees: { some: { userId } } }) }, include: taskInclude,
    });
    if (!task) throw new NotFoundException('Задача не найдена.');
    return task;
  }

  async update(userId: string, workspaceId: string, departmentId: string, id: string, dto: TaskDto) {
    return this.team.transaction(workspaceId, async (tx) => {
      const { canManage } = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      this.manager(canManage);
      const current = await this.find(tx, departmentId, id, userId, true);
      const { assigneeEmails, dueDate, ...details } = dto;
      const assignees = await this.assignees(tx, departmentId, assigneeEmails, current.assignees);
      const task = await tx.task.update({
        where: { id }, data: { ...details, dueDate: new Date(dueDate), assignees: { deleteMany: {}, create: assignees } },
        include: taskInclude,
      });
      return this.present(task, userId, true);
    });
  }

  async setStatus(userId: string, workspaceId: string, departmentId: string, id: string, status: TaskStatus) {
    return this.team.transaction(workspaceId, async (tx) => {
      const { canManage } = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      await this.find(tx, departmentId, id, userId, canManage);
      if (!canManage && status === 'done') throw new ForbiddenException('Статус «Готово» устанавливает администратор.');
      const task = await tx.task.update({ where: { id }, data: { status }, include: taskInclude });
      return this.present(task, userId, canManage);
    });
  }

  async remove(userId: string, workspaceId: string, departmentId: string, id: string) {
    return this.team.transaction(workspaceId, async (tx) => {
      const { canManage } = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      this.manager(canManage);
      await this.find(tx, departmentId, id, userId, true);
      await tx.task.delete({ where: { id } });
      return { success: true };
    });
  }
}
