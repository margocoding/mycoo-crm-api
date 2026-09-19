import {
  BadRequestException, ConflictException, ForbiddenException, GoneException,
  HttpException, Injectable, NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { DepartmentRole, WorkspaceRole } from '../../generated/prisma/enums.js';
import { AuthService } from '../auth/auth.service.js';
import { MailService } from '../mail/mail.service.js';
import { RedisService } from '../redis/redis.service.js';
import type { DepartmentDto, InvitationDto } from './dto/team.dto.js';

const invitationSelect = {
  id: true, email: true, name: true, role: true, departmentId: true,
  expiresAt: true, createdAt: true,
} as const;

@Injectable()
export class TeamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly redis: RedisService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  private async workspace(db: Prisma.TransactionClient, userId: string, id: string) {
    const workspace = await db.workspace.findFirst({
      where: { id, OR: [{ ownerId: userId }, { members: { some: { userId } } }] },
    });
    if (!workspace) throw new NotFoundException('Компания не найдена.');
    return workspace;
  }

  async departmentAccess(db: Prisma.TransactionClient, userId: string, workspaceId: string, departmentId: string) {
    const workspace = await this.workspace(db, userId, workspaceId);
    const department = await db.department.findFirst({
      where: { id: departmentId, workspaceId },
      include: { members: { where: { userId }, select: { role: true } } },
    });
    if (!department) throw new NotFoundException('Департамент не найден.');
    const role = department.members[0]?.role;
    const isOwner = workspace.ownerId === userId;
    if (!isOwner && !role) throw new ForbiddenException('Нет доступа к департаменту.');
    return { workspace, department, isOwner, canManage: isOwner || role === DepartmentRole.CHIEF || role === DepartmentRole.ADMIN,
      canAssignChief: isOwner || role === DepartmentRole.CHIEF };
  }

  private async access(db: Prisma.TransactionClient, userId: string, workspaceId: string, departmentId: string) {
    const access = await this.departmentAccess(db, userId, workspaceId, departmentId);
    if (!access.canManage)
      throw new ForbiddenException('Управление командой доступно руководителю и администратору.');
    return access;
  }

  transaction<T>(workspaceId: string, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', 'team:' + workspaceId);
      return action(tx);
    });
  }

  async getTeam(userId: string, workspaceId: string) {
    const workspace = await this.workspace(this.prisma, userId, workspaceId);
    const isOwner = workspace.ownerId === userId;
    const rows = await this.prisma.department.findMany({
      where: { workspaceId, ...(isOwner ? {} : { members: { some: { userId } } }) },
      include: { members: { where: { userId }, select: { role: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const departments = rows.map(({ members, ...d }) => ({
      ...d,
      myRole: isOwner ? null : members[0]?.role ?? null,
      canManage: isOwner || members.some((m) => m.role !== DepartmentRole.WORKER),
      canAssignChief: isOwner || members.some((m) => m.role === DepartmentRole.CHIEF),
    }));
    const managedIds = departments.filter((d) => d.canManage).map((d) => d.id);
    const [memberships, invitations] = await Promise.all([
      this.prisma.departmentMember.findMany({
        where: {
          departmentId: { in: departments.map((d) => d.id) },
          OR: [{ userId }, { departmentId: { in: managedIds } }],
        },
        select: {
          role: true, user: { select: { id: true, email: true, name: true } },
          department: { select: { id: true, name: true } },
        },
        orderBy: { user: { email: 'asc' } },
      }),
      this.prisma.teamInvitation.findMany({
        where: { departmentId: { in: managedIds }, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        select: invitationSelect, orderBy: { createdAt: 'desc' },
      }),
    ]);
    const members = new Map<string, {
      id: string; email: string; name: string; isOwner: boolean;
      departments: Array<{ id: string; name: string; role: DepartmentRole }>;
    }>();
    for (const { user, department, role } of memberships) {
      const row = members.get(user.id) ?? {
        ...user,
        isOwner: user.id === workspace.ownerId,
        name: user.name || (user.id === workspace.ownerId ? workspace.ownerName : null) || user.email,
        departments: [],
      };
      row.departments.push({ ...department, role });
      members.set(user.id, row);
    }
    if (isOwner || managedIds.length) {
      const owner = await this.prisma.user.findUniqueOrThrow({
        where: { id: workspace.ownerId }, select: { id: true, email: true, name: true },
      });
      members.set(owner.id, { ...owner, name: owner.name || workspace.ownerName || owner.email,
        isOwner: true, departments: [] });
    }
    return { workspaceId, isOwner, departments, members: [...members.values()], invitations };
  }

  async createDepartment(userId: string, workspaceId: string, dto: DepartmentDto) {
    return this.transaction(workspaceId, async (tx) => {
      const workspace = await this.workspace(tx, userId, workspaceId);
      if (workspace.ownerId !== userId) throw new ForbiddenException('Департаменты создаёт владелец компании.');
      if (!workspace.diagnosticsComplete || !workspace.isActive)
        throw new BadRequestException('Сначала завершите диагностику компании.');
      await this.checkName(tx, workspaceId, dto.name);
      return tx.department.create({
        data: { workspaceId, name: dto.name, description: dto.description || null },
      });
    });
  }

  async editDepartment(userId: string, workspaceId: string, id: string, dto: DepartmentDto) {
    return this.transaction(workspaceId, async (tx) => {
      await this.access(tx, userId, workspaceId, id);
      await this.checkName(tx, workspaceId, dto.name, id);
      return tx.department.update({ where: { id }, data: { name: dto.name, description: dto.description || null } });
    });
  }

  private async checkName(tx: Prisma.TransactionClient, workspaceId: string, name: string, exceptId?: string) {
    const departments = await tx.department.findMany({
      where: { workspaceId, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { name: true },
    });
    if (departments.some((d) => d.name.toLowerCase() === name.toLowerCase()))
      throw new ConflictException('Департамент с таким названием уже существует.');
  }

  async invite(userId: string, workspaceId: string, departmentId: string, dto: InvitationDto) {
    return this.transaction(workspaceId, async (tx) => {
      const access = await this.access(tx, userId, workspaceId, departmentId);
      if (!access.workspace.isActive) throw new BadRequestException('Компания сейчас недоступна.');
      const owner = await tx.user.findUniqueOrThrow({ where: { id: access.workspace.ownerId }, select: { email: true } });
      if (owner.email === dto.email) throw new ForbiddenException('Собственник уже имеет доступ ко всем департаментам. Его роль нельзя изменить.');
      if (dto.role === DepartmentRole.CHIEF && !access.canAssignChief)
        throw new ForbiddenException('Администратор не может назначать руководителя.');
      const member = await tx.departmentMember.findFirst({ where: { departmentId, user: { email: dto.email } } });
      if (member) throw new ConflictException('Этот пользователь уже в департаменте. Измените его роль в списке.');
      const pending = { departmentId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } };
      if (!access.canAssignChief && await tx.teamInvitation.findFirst({
        where: { ...pending, role: DepartmentRole.CHIEF, email: dto.email },
      })) throw new ForbiddenException('Администратор не может перевыпускать приглашение руководителю.');
      if (dto.role === DepartmentRole.CHIEF && await tx.teamInvitation.findFirst({
        where: { ...pending, role: DepartmentRole.CHIEF, email: { not: dto.email } },
      })) throw new ConflictException('Приглашение руководителю уже создано. Сначала отмените его.');
      await tx.teamInvitation.updateMany({
        where: { ...pending, email: dto.email }, data: { revokedAt: new Date() },
      });
      const token = randomBytes(32).toString('base64url');
      const invitation = await tx.teamInvitation.create({
        data: {
          email: dto.email, name: dto.name || null, role: dto.role, departmentId,
          invitedById: userId, tokenHash: this.tokenHash(token),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        select: invitationSelect,
      });
      
      const domain = this.config.get<string>('APP_URL', 'https://mycoo.io');
      const link = `${domain}/invite/${token}`;
      const inviter = await tx.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
      const inviterName = inviter?.name || (access.workspace.ownerId === userId ? access.workspace.ownerName : null) || inviter?.email || '';
      
      const roleNames = {
        [DepartmentRole.CHIEF]: 'Руководитель',
        [DepartmentRole.ADMIN]: 'Администратор',
        [DepartmentRole.WORKER]: 'Сотрудник',
      };
      
      await this.mail.sendInvitation(
        dto.email,
        link,
        access.workspace.company!,
        access.department.name,
        roleNames[dto.role] || 'Сотрудник',
        inviterName,
      );

      return { invitation, token };
    });
  }

  async revoke(userId: string, workspaceId: string, id: string) {
    return this.transaction(workspaceId, async (tx) => {
      const invitation = await tx.teamInvitation.findFirst({ where: { id, department: { workspaceId } } });
      if (!invitation) throw new NotFoundException('Приглашение не найдено.');
      const access = await this.access(tx, userId, workspaceId, invitation.departmentId);
      if (invitation.role === DepartmentRole.CHIEF && !access.canAssignChief)
        throw new ForbiddenException('Только руководитель может отменить это приглашение.');
      if (invitation.acceptedAt) throw new ConflictException('Приглашение уже принято. Обновите список команды.');
      await tx.teamInvitation.update({ where: { id }, data: { revokedAt: new Date() } });
      if (!await tx.teamInvitation.count({ where: { departmentId: invitation.departmentId, email: invitation.email,
        acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } } })) {
        await tx.taskAssignee.deleteMany({ where: { email: invitation.email, userId: null,
          departmentId: invitation.departmentId } });
      }
      return { success: true };
    });
  }

  async setRole(userId: string, workspaceId: string, departmentId: string, targetId: string, role: DepartmentRole) {
    return this.transaction(workspaceId, async (tx) => {
      const access = await this.access(tx, userId, workspaceId, departmentId);
      this.protectOwner(access.workspace.ownerId, targetId);
      const member = await tx.departmentMember.findUnique({
        where: { departmentId_userId: { departmentId, userId: targetId } },
      });
      if (!member) throw new NotFoundException('Участник не найден.');
      if ((role === DepartmentRole.CHIEF || member.role === DepartmentRole.CHIEF) && !access.canAssignChief)
        throw new ForbiddenException('Администратор не может менять руководителя.');
      if (member.role === DepartmentRole.CHIEF && role !== DepartmentRole.CHIEF)
        throw new ConflictException('Сначала назначьте другого руководителя.');
      if (role === DepartmentRole.CHIEF) await this.demoteChief(tx, departmentId, targetId);
      await tx.departmentMember.update({ where: { id: member.id }, data: { role } });
      return { success: true };
    });
  }

  private async demoteChief(tx: Prisma.TransactionClient, departmentId: string, exceptUserId: string) {
    await tx.departmentMember.updateMany({
      where: { departmentId, role: DepartmentRole.CHIEF, userId: { not: exceptUserId } },
      data: { role: DepartmentRole.ADMIN },
    });
  }

  private protectOwner(ownerId: string, targetId: string) {
    if (ownerId === targetId) throw new ForbiddenException('Роль и доступ собственника нельзя изменить.');
  }

  async removeMember(userId: string, workspaceId: string, departmentId: string, targetId: string) {
    return this.transaction(workspaceId, async (tx) => {
      const { workspace } = await this.access(tx, userId, workspaceId, departmentId);
      this.protectOwner(workspace.ownerId, targetId);
      const member = await tx.departmentMember.findUnique({
        where: { departmentId_userId: { departmentId, userId: targetId } },
      });
      if (!member) throw new NotFoundException('Участник не найден.');
      if (member.role === DepartmentRole.CHIEF) throw new ConflictException('Сначала назначьте другого руководителя.');
      await tx.departmentMember.delete({ where: { id: member.id } });
      await tx.taskAssignee.deleteMany({ where: { userId: targetId, departmentId } });
      if (workspace.ownerId !== targetId && !await tx.departmentMember.count({
        where: { userId: targetId, department: { workspaceId } },
      })) await tx.workspaceMember.deleteMany({ where: { workspaceId, userId: targetId } });
      return { success: true };
    });
  }

  async setDepartments(userId: string, workspaceId: string, targetId: string, departmentIds: string[]) {
    return this.transaction(workspaceId, async (tx) => {
      const workspace = await this.workspace(tx, userId, workspaceId);
      this.protectOwner(workspace.ownerId, targetId);
      const managed = await tx.department.findMany({
        where: { workspaceId, ...(workspace.ownerId === userId ? {} : {
          members: { some: { userId, role: { in: [DepartmentRole.CHIEF, DepartmentRole.ADMIN] } } },
        }) },
        select: { id: true },
      });
      const managedIds = new Set(managed.map((d) => d.id));
      const memberships = await tx.departmentMember.findMany({ where: { userId: targetId, department: { workspaceId } } });
      if (!memberships.some((m) => managedIds.has(m.departmentId)))
        throw new ForbiddenException('Нет доступа к этому участнику.');
      const current = new Set(memberships.map((m) => m.departmentId));
      if (departmentIds.some((id) => !managedIds.has(id) && !current.has(id)))
        throw new ForbiddenException('Нет доступа к выбранному департаменту.');
      const removed = memberships.filter((m) => managedIds.has(m.departmentId) && !departmentIds.includes(m.departmentId));
      if (removed.some((m) => m.role === DepartmentRole.CHIEF))
        throw new ConflictException('Перед удалением руководителя назначьте ему замену.');
      await tx.departmentMember.deleteMany({ where: { id: { in: removed.map((m) => m.id) } } });
      await tx.taskAssignee.deleteMany({ where: { userId: targetId,
        departmentId: { in: removed.map((m) => m.departmentId) } } });
      await tx.departmentMember.createMany({
        data: departmentIds.filter((id) => !current.has(id)).map((departmentId) => ({
          departmentId, userId: targetId, role: DepartmentRole.WORKER,
        })),
      });
      const target = await tx.user.findUniqueOrThrow({ where: { id: targetId }, select: { email: true, name: true } });
      await tx.taskAssignee.updateMany({ where: { email: target.email, userId: null,
        departmentId: { in: departmentIds.filter((id) => !current.has(id)) } }, data: { userId: targetId, name: target.name } });
      return { success: true };
    });
  }

  private tokenHash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private async activeInvitation(db: Prisma.TransactionClient, token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new NotFoundException('Приглашение не найдено.');
    const invitation = await db.teamInvitation.findUnique({
      where: { tokenHash: this.tokenHash(token) },
      include: {
        department: { include: { workspace: true } },
        invitedBy: { select: { name: true, email: true } },
      },
    });
    if (!invitation) throw new NotFoundException('Приглашение не найдено.');
    if (invitation.acceptedAt || invitation.revokedAt || invitation.expiresAt <= new Date())
      throw new GoneException('Приглашение использовано, отменено или срок ссылки истёк. Попросите новую ссылку.');
    const { workspace } = invitation.department;
    if (!workspace.isActive || !workspace.diagnosticsComplete) throw new GoneException('Компания сейчас недоступна.');
    try {
      const access = await this.access(db, invitation.invitedById, workspace.id, invitation.departmentId);
      if (invitation.role === DepartmentRole.CHIEF && !access.canAssignChief) throw new ForbiddenException();
    } catch (error) {
      if (error instanceof ForbiddenException || error instanceof NotFoundException)
        throw new GoneException('Приглашение больше не действует. Попросите новую ссылку.');
      throw error;
    }
    return invitation;
  }

  async getInvitation(token: string) {
    const invitation = await this.activeInvitation(this.prisma, token);
    const existing = await this.prisma.user.findUnique({ where: { email: invitation.email }, select: { id: true } });
    const workspace = invitation.department.workspace;
    return {
      email: invitation.email, name: invitation.name, role: invitation.role,
      company: workspace.company, department: invitation.department.name,
      invitedBy: invitation.invitedBy.name || (workspace.ownerId === invitation.invitedById ? workspace.ownerName : null) || invitation.invitedBy.email,
      expiresAt: invitation.expiresAt, existingAccount: Boolean(existing),
    };
  }

  async accept(token: string, password: string) {
    const initial = await this.activeInvitation(this.prisma, token);
    const existing = await this.prisma.user.findUnique({ where: { email: initial.email } });
    const attemptKey = 'team:password:' + this.tokenHash(initial.email);
    if (existing && await this.redis.countAttempt(attemptKey, 900) > 5)
      throw new HttpException('Слишком много попыток. Повторите через 15 минут.', 429);
    if (existing && !await this.auth.comparePassword(password, existing.passwordHash))
      throw new BadRequestException('Введите действующий пароль этого аккаунта.');
    const passwordHash = existing ? null : await this.auth.hashPassword(password);
    const workspaceId = initial.department.workspaceId;
    const user = await this.transaction(workspaceId, async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', 'invite-email:' + initial.email);
      const invitation = await this.activeInvitation(tx, token);
      const current = await tx.user.findUnique({ where: { email: invitation.email } });
      if (current) this.protectOwner(invitation.department.workspace.ownerId, current.id);
      if (current?.id !== existing?.id || current?.passwordHash !== existing?.passwordHash)
        throw new ConflictException('Аккаунт изменился. Обновите страницу и введите действующий пароль.');
      const member = current ?? await tx.user.create({
        data: { email: invitation.email, name: invitation.name, passwordHash: passwordHash! },
      });
      if (await tx.departmentMember.findUnique({
        where: { departmentId_userId: { departmentId: invitation.departmentId, userId: member.id } },
      })) throw new ConflictException('Вы уже состоите в этом департаменте.');
      const claimed = await tx.teamInvitation.updateMany({
        where: { id: invitation.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date() },
      });
      if (!claimed.count) throw new GoneException('Приглашение больше не действует.');
      await tx.workspaceMember.upsert({
        where: { userId_workspaceId: { userId: member.id, workspaceId } },
        create: { userId: member.id, workspaceId, role: WorkspaceRole.TEAM_MEMBER }, update: {},
      });
      if (invitation.role === DepartmentRole.CHIEF) await this.demoteChief(tx, invitation.departmentId, member.id);
      await tx.departmentMember.create({
        data: { userId: member.id, departmentId: invitation.departmentId, role: invitation.role },
      });
      await tx.taskAssignee.updateMany({
        where: { email: invitation.email, userId: null, departmentId: invitation.departmentId },
        data: { userId: member.id, name: member.name || invitation.name },
      });
      return member;
    });
    await this.redis.delete(attemptKey);
    return { ...await this.auth.buildAuthRdo(user), workspaceId, departmentId: initial.departmentId };
  }
}
