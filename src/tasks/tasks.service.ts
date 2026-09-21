import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { TeamService } from '../team/team.service.js';
import type { TaskDto, TaskStatus } from './dto/task.dto.js';
import { DashboardService } from '../dashboard/dashboard.service.js';

const taskInclude = {
  assignees: { orderBy: { email: 'asc' as const } },
  departments: { include: { department: { select: { id: true, name: true } } } },
};
type TaskRow = Prisma.TaskGetPayload<{ include: typeof taskInclude }>;
type Access = Awaited<ReturnType<TeamService['departmentAccess']>>;

@Injectable()
export class TasksService {
  constructor(private readonly team: TeamService, private readonly dashboard: DashboardService) {}

  private canEdit(task: TaskRow, access: Access) {
    return access.canManage && (access.isOwner || task.departments.length === 1);
  }

  private present(task: TaskRow, userId: string, access: Access) {
    const departmentId = access.department.id;
    return {
      ...task, departmentId,
      startDate: task.startDate.toISOString().slice(0, 10), dueDate: task.dueDate.toISOString().slice(0, 10),
      isShared: task.departments.length > 1, canManage: this.canEdit(task, access), canComplete: access.canManage,
      departments: task.departments.filter((d) => access.isOwner || d.departmentId === departmentId).map((d) => d.department),
      assignees: task.assignees.filter((a) => access.isOwner ||
        (a.departmentId === departmentId && (access.canManage || a.userId === userId)))
        .map(({ email, name, userId, departmentId }) => ({ email, name, userId, departmentId })),
    };
  }

  private manager(canManage: boolean) {
    if (!canManage) throw new ForbiddenException('Управление задачами доступно собственнику, руководителю и администратору.');
  }

  private async taskData(tx: Prisma.TransactionClient, access: Access, dto: TaskDto, current?: TaskRow) {
    const startDate = dto.startDate ?? current?.startDate.toISOString().slice(0, 10) ?? dto.dueDate;
    if (startDate > dto.dueDate) throw new BadRequestException('Дата начала не может быть позже даты окончания.');
    if (Boolean(dto.assignees) === Boolean(dto.assigneeEmails))
      throw new BadRequestException('Передайте один список исполнителей.');
    // Keep the previous single-department payload valid during deployment of the client.
    const requested = dto.assignees ?? dto.assigneeEmails!.map((email) => ({ departmentId: access.department.id, email }));
    if (new Set(requested.map((a) => a.departmentId + ':' + a.email)).size !== requested.length)
      throw new BadRequestException('Исполнители в департаменте не должны повторяться.');
    const departmentIds = [...new Set(requested.map((a) => a.departmentId))];
    if (!departmentIds.includes(access.department.id))
      throw new BadRequestException('Выберите исполнителя из текущего департамента.');
    if (!access.isOwner && departmentIds.some((id) => id !== access.department.id))
      throw new ForbiddenException('Назначать задачи нескольким департаментам может только собственник.');
    const count = await tx.department.count({ where: { workspaceId: access.workspace.id, id: { in: departmentIds } } });
    if (count !== departmentIds.length) throw new BadRequestException('Выберите департаменты этой компании.');

    const emails = [...new Set(requested.map((a) => a.email))];
    const [members, invitations, owner] = await Promise.all([
      tx.departmentMember.findMany({ where: { departmentId: { in: departmentIds }, user: { email: { in: emails } } },
        include: { user: { select: { email: true, name: true } } } }),
      tx.teamInvitation.findMany({ where: { departmentId: { in: departmentIds }, email: { in: emails },
        acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } }, orderBy: { createdAt: 'desc' } }),
      tx.user.findUniqueOrThrow({ where: { id: access.workspace.ownerId }, select: { id: true, email: true, name: true } }),
    ]);
    const assignees = requested.map(({ email, departmentId }) => {
      if (email === owner.email) return { email, departmentId, name: owner.name, userId: owner.id };
      const member = members.find((m) => m.departmentId === departmentId && m.user.email === email);
      if (member) return { email, departmentId, name: member.user.name, userId: member.userId };
      const invitation = invitations.find((i) => i.departmentId === departmentId && i.email === email);
      if (invitation) return { email, departmentId, name: invitation.name, userId: null };
      // An expired invitation may remain on the same task and department until reissued.
      const previous = current?.assignees.find((a) => a.departmentId === departmentId && a.email === email && !a.userId);
      if (previous) return { email, departmentId, name: previous.name, userId: null };
      throw new BadRequestException('Исполнители должны состоять в выбранном департаменте или иметь действующее приглашение.');
    });
    return { departmentIds, assignees, details: {
      title: dto.title, startDate: new Date(startDate), dueDate: new Date(dto.dueDate),
      priority: dto.priority, successCriteria: dto.successCriteria,
    } };
  }

  async list(userId: string, workspaceId: string, departmentId: string) {
    return this.team.transaction(workspaceId, async (tx) => {
      const access = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      const tasks = await tx.task.findMany({
        where: { workspaceId, departments: { some: { departmentId } },
          ...(access.canManage ? {} : { assignees: { some: { userId, departmentId } } }) },
        include: taskInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      });
      return { canManage: access.canManage, tasks: tasks.map((t) => this.present(t, userId, access)) };
    });
  }

  async create(userId: string, workspaceId: string, departmentId: string, dto: TaskDto) {
    return this.team.transaction(workspaceId, async (tx) => {
      const access = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      this.manager(access.canManage);
      const { departmentIds, assignees, details } = await this.taskData(tx, access, dto);
      const task = await tx.task.create({
        data: { ...details, workspaceId, departments: { create: departmentIds.map((departmentId) => ({ departmentId })) },
          assignees: { create: assignees } }, include: taskInclude,
      });
      return this.present(task, userId, access);
    });
  }

  private async find(tx: Prisma.TransactionClient, access: Access, id: string, userId: string) {
    const task = await tx.task.findFirst({
      where: { id, workspaceId: access.workspace.id, departments: { some: { departmentId: access.department.id } },
        ...(access.canManage ? {} : { assignees: { some: { userId, departmentId: access.department.id } } }) }, include: taskInclude,
    });
    if (!task) throw new NotFoundException('Задача не найдена.');
    return task;
  }

  private requireEdit(task: TaskRow, access: Access) {
    this.manager(access.canManage);
    if (!this.canEdit(task, access)) throw new ForbiddenException('Общую задачу нескольких департаментов изменяет только собственник.');
  }

  async update(userId: string, workspaceId: string, departmentId: string, id: string, dto: TaskDto) {
    return this.team.transaction(workspaceId, async (tx) => {
      const access = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      const current = await this.find(tx, access, id, userId);
      this.requireEdit(current, access);
      const { departmentIds, assignees, details } = await this.taskData(tx, access, dto, current);
      const task = await tx.task.update({
        where: { id }, data: { ...details,
          departments: { deleteMany: {}, create: departmentIds.map((departmentId) => ({ departmentId })) },
          assignees: { deleteMany: {}, create: assignees } }, include: taskInclude,
      });
      return this.present(task, userId, access);
    });
  }

  async setStatus(userId: string, workspaceId: string, departmentId: string, id: string, status: TaskStatus) {
    const { result, refreshKeys } = await this.team.transaction(workspaceId, async (tx) => {
      const access = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      const previous = await this.find(tx, access, id, userId);
      if (!access.canManage && status === 'done') throw new ForbiddenException('Статус «Готово» устанавливает руководитель или администратор.');
      const task = await tx.task.update({ where: { id }, data: { status }, include: taskInclude });
      const refreshKeys = status === 'done' && previous.status !== 'done'
        ? await this.dashboard.requestRefresh(tx, workspaceId, task.departments.map(d => d.departmentId)) : [];
      return { result: this.present(task, userId, access), refreshKeys };
    });
    await this.dashboard.enqueue(refreshKeys);
    return result;
  }

  async remove(userId: string, workspaceId: string, departmentId: string, id: string) {
    return this.team.transaction(workspaceId, async (tx) => {
      const access = await this.team.departmentAccess(tx, userId, workspaceId, departmentId);
      this.requireEdit(await this.find(tx, access, id, userId), access);
      await tx.task.delete({ where: { id } });
      return { success: true };
    });
  }
}
