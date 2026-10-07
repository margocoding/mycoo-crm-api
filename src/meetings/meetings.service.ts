import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { TeamService } from '../team/team.service.js';
import { TasksService } from '../tasks/tasks.service.js';
import { CallsClient } from './calls.client.js';
import type {
  MeetingActionDto,
  MeetingDto,
  PublishProtocolDto,
} from './meetings.dto.js';
import { parseMeetingAnalysis } from './meeting-analysis.js';
import { GigachatService } from '../gigachat/gigachat.service.js';

const include = {
  participants: {
    include: { user: { select: { id: true, name: true, email: true } } },
  },
  recordings: { orderBy: { createdAt: 'asc' as const } },
  department: { select: { name: true } },
};

@Injectable()
export class MeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly team: TeamService,
    private readonly tasks: TasksService,
    private readonly calls: CallsClient,
    private readonly config: ConfigService,
    private readonly ai: GigachatService,
  ) {}

  async access(
    userId: string,
    workspaceId: string,
    id: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    const meeting = await db.meeting.findFirst({
      where: { id, workspaceId },
      include,
    });
    if (!meeting) throw new NotFoundException('Встреча не найдена.');
    const access = await this.team.departmentAccess(
      db,
      userId,
      workspaceId,
      meeting.departmentId,
    );
    const member = meeting.participants.find((p) => p.userId === userId);
    if (!access.isOwner && (!member || member.removed))
      throw new ForbiddenException('Вы не приглашены на эту встречу.');
    const host = access.isOwner || meeting.organizerId === userId;
    return {
      meeting,
      access,
      member,
      host,
      moderator: host || member?.role === 'cohost',
    };
  }

  async list(userId: string, workspaceId: string) {
    const team = await this.team.getTeam(userId, workspaceId);
    const where: Prisma.MeetingWhereInput = {
      workspaceId,
      ...(team.isOwner
        ? {}
        : {
            departmentId: { in: team.departments.map((d) => d.id) },
            participants: { some: { userId, removed: false } },
          }),
    };
    const meetings = await this.prisma.meeting.findMany({
      where,
      orderBy: { startsAt: 'desc' },
      take: 200,
      select: {
        id: true,
        title: true,
        startsAt: true,
        duration: true,
        departmentId: true,
        organizerId: true,
        status: true,
        kind: true,
        agenda: true,
        objective: true,
        waitingRoom: true,
        muteOnEntry: true,
        allowScreenShare: true,
        department: { select: { name: true } },
        participants: {
          select: {
            userId: true,
            role: true,
            user: { select: { name: true } },
          },
        },
      },
    });
    return {
      meetings: meetings.map((m) => ({
        ...m,
        departmentName: m.department.name,
        participants: m.participants.map((p) => ({
          personId: p.userId,
          role: p.role,
          name: p.user.name || 'Участник',
        })),
      })),
      departments: team.departments,
      members: team.members,
      callsAvailable: this.calls.configured,
    };
  }

  async get(userId: string, workspaceId: string, id: string) {
    const {
      meeting: m,
      access,
      host,
      moderator,
      member,
    } = await this.access(userId, workspaceId, id);
    const canReview = access.canManage && moderator;
    const linkedTasks = await this.prisma.task.findMany({
      where: {
        meetingId: id,
        ...(access.canManage ? {} : { assignees: { some: { userId } } }),
      },
      select: { id: true, title: true, status: true, dueDate: true },
      orderBy: { createdAt: 'asc' },
    });
    const people = await this.prisma.user.findMany({
      where: {
        OR: [
          { id: access.workspace.ownerId },
          { departments: { some: { departmentId: m.departmentId } } },
        ],
      },
      select: { id: true, name: true },
    });
    return {
      id: m.id,
      title: m.title,
      startsAt: m.startsAt,
      duration: m.duration,
      departmentId: m.departmentId,
      departmentName: m.department.name,
      organizerId: m.organizerId,
      kind: m.kind,
      objective: m.objective,
      agenda: m.agenda,
      status: m.status,
      waitingRoom: m.waitingRoom,
      muteOnEntry: m.muteOnEntry,
      allowScreenShare: m.allowScreenShare,
      locked: m.locked,
      startedAt: m.startedAt,
      endedAt: m.endedAt,
      previousId: m.previousId,
      notes: m.notes,
      participants: m.participants.map((p) => ({
        personId: p.userId,
        role: p.role,
        name: p.user.name || 'Участник',
        admitted: p.admitted,
        removed: p.removed,
        raisedHand: p.raisedHand,
        requestedAt: moderator ? p.requestedAt : undefined,
      })),
      recordings: m.recordings.map((r) => ({
        id: r.id,
        status: r.status,
        error: r.error,
        createdAt: r.createdAt,
        downloadable: Boolean(r.fileKey),
      })),
      transcript: canReview || m.publishedAt ? m.transcript : null,
      analysis: canReview || m.publishedAt ? m.analysis : null,
      analysisStatus: canReview || m.publishedAt ? m.analysisStatus : 'none',
      analysisRevision: m.analysisRevision,
      analysisError: canReview ? m.analysisError : null,
      publishedAt: m.publishedAt,
      canHost: host,
      canModerate: moderator,
      canReview,
      myRole: host ? 'host' : member?.role || 'participant',
      people: people.map((p) => ({ id: p.id, name: p.name || 'Сотрудник' })),
      tasks: linkedTasks,
      callsAvailable: this.calls.configured,
    };
  }

  private async validateDraft(
    tx: Prisma.TransactionClient,
    userId: string,
    workspaceId: string,
    dto: MeetingDto,
    organizerId = userId,
  ) {
    const access = await this.team.departmentAccess(
      tx,
      userId,
      workspaceId,
      dto.departmentId,
    );
    if (!access.canManage)
      throw new ForbiddenException(
        'Создать встречу может собственник, руководитель или администратор.',
      );
    if (!dto.title.trim() || !dto.objective.trim())
      throw new BadRequestException(
        'Укажите название и ожидаемый результат встречи.',
      );
    if (new Date(dto.startsAt).getTime() < Date.now() - 60_000)
      throw new BadRequestException('Дата встречи уже прошла.');
    if (
      dto.participants.some(
        (p) => p.role === 'host' && p.personId !== organizerId,
      )
    )
      throw new BadRequestException(
        'Организатором становится создатель встречи.',
      );
    const ids = [
      ...new Set([organizerId, ...dto.participants.map((p) => p.personId)]),
    ];
    const count = await tx.user.count({
      where: {
        id: { in: ids },
        OR: [
          { id: access.workspace.ownerId },
          { departments: { some: { departmentId: dto.departmentId } } },
        ],
      },
    });
    if (count !== ids.length)
      throw new BadRequestException('Выберите сотрудников этого департамента.');
    if (dto.previousId) {
      const previous = await this.access(
        userId,
        workspaceId,
        dto.previousId,
        tx,
      );
      if (
        previous.meeting.departmentId !== dto.departmentId ||
        previous.meeting.status !== 'completed'
      )
        throw new BadRequestException(
          'Выберите завершённую встречу этого отдела.',
        );
    }
    return {
      title: dto.title.trim(),
      kind: dto.kind,
      objective: dto.objective.trim(),
      startsAt: new Date(dto.startsAt),
      duration: dto.duration,
      departmentId: dto.departmentId,
      agenda: dto.agenda.trim(),
      waitingRoom: dto.waitingRoom,
      muteOnEntry: dto.muteOnEntry,
      allowScreenShare: dto.allowScreenShare,
      previousId: dto.previousId || null,
      participants: ids.map((id) => ({
        userId: id,
        role:
          id === organizerId
            ? 'host'
            : dto.participants.find((p) => p.personId === id)?.role ||
              'participant',
      })),
    };
  }

  async create(userId: string, workspaceId: string, dto: MeetingDto) {
    const id = await this.team.transaction(workspaceId, async (tx) => {
      const { participants, ...data } = await this.validateDraft(
        tx,
        userId,
        workspaceId,
        dto,
      );
      const m = await tx.meeting.create({
        data: {
          ...data,
          workspaceId,
          organizerId: userId,
          roomName: 'meeting_' + randomUUID(),
          participants: { create: participants },
        },
      });
      await this.notify(
        tx,
        m,
        participants.map((p) => p.userId).filter((id) => id !== userId),
        'MEETING_INVITED',
      );
      return m.id;
    });
    return this.get(userId, workspaceId, id);
  }

  async edit(userId: string, workspaceId: string, id: string, dto: MeetingDto) {
    await this.team.transaction(workspaceId, async (tx) => {
      const { meeting, host } = await this.access(userId, workspaceId, id, tx);
      if (!host || meeting.status !== 'scheduled')
        throw new ForbiddenException(
          'Изменять можно свою запланированную встречу.',
        );
      // Keep its original organizer, including when the workspace owner edits it.
      if (dto.previousId === id)
        throw new BadRequestException(
          'Нельзя выбрать эту же встречу в качестве предыдущей.',
        );
      const { participants, ...data } = await this.validateDraft(
        tx,
        userId,
        workspaceId,
        dto,
        meeting.organizerId,
      );
      await tx.meeting.update({
        where: { id },
        data: {
          ...data,
          participants: { deleteMany: {}, create: participants },
        },
      });
      const old = new Set(meeting.participants.map((p) => p.userId));
      await this.notify(
        tx,
        { ...meeting, ...data },
        participants.filter((p) => !old.has(p.userId)).map((p) => p.userId),
        'MEETING_INVITED',
      );
    });
    return this.get(userId, workspaceId, id);
  }

  private async notify(
    tx: Prisma.TransactionClient,
    m: { id: string; title: string; workspaceId: string; departmentId: string },
    userIds: string[],
    kind: 'MEETING_INVITED' | 'MEETING_PROTOCOL',
  ) {
    const link = new URL(
      '/dashboard/calls',
      this.config.get('APP_URL', 'https://mycoo.io'),
    );
    link.searchParams.set('meeting', m.id);
    link.searchParams.set('workspace', m.workspaceId);
    await tx.notification.createMany({
      data: [...new Set(userIds)].map((recipientId) => ({
        recipientId,
        workspaceId: m.workspaceId,
        departmentId: m.departmentId,
        meetingId: m.id,
        kind,
        message: `${kind === 'MEETING_INVITED' ? 'Вы приглашены на встречу' : 'Опубликован протокол встречи'} «${m.title}». ${link}`,
      })),
    });
  }

  async join(userId: string, workspaceId: string, id: string) {
    const result = await this.team.transaction(workspaceId, async (tx) => {
      const {
        meeting: m,
        member,
        moderator,
        access,
      } = await this.access(userId, workspaceId, id, tx);
      if (m.status !== 'live')
        throw new ConflictException(
          m.status === 'scheduled'
            ? 'Организатор ещё не начал встречу.'
            : 'Встреча завершена.',
        );
      if (m.locked && !moderator)
        throw new ForbiddenException('Вход во встречу закрыт организатором.');
      if (m.waitingRoom && !moderator && !member?.admitted) {
        await tx.meetingParticipant.update({
          where: { id: member!.id },
          data: { requestedAt: new Date() },
        });
        return { waiting: true as const };
      }
      if (!member && access.isOwner)
        await tx.meetingParticipant.create({
          data: { meetingId: id, userId, role: 'cohost', admitted: true },
        });
      const user = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { name: true },
      });
      return {
        waiting: false as const,
        room: m.roomName,
        name: user.name || 'Участник',
        screenShare: moderator || m.allowScreenShare,
      };
    });
    if (result.waiting) return result;
    return {
      waiting: false,
      ...(await this.calls.request<{ token: string; url: string }>(
        result.room,
        '/token',
        'POST',
        {
          identity: userId,
          name: result.name,
          screenShare: result.screenShare,
        },
      )),
    };
  }

  async action(
    userId: string,
    workspaceId: string,
    id: string,
    dto: MeetingActionDto,
  ) {
    const { action, personId } = dto;
    const room = await this.team.transaction(workspaceId, async (tx) => {
      const {
        meeting: m,
        moderator,
        host,
        member,
      } = await this.access(userId, workspaceId, id, tx);
      if (['raise', 'lower'].includes(action)) {
        if (m.status !== 'live' || !member)
          throw new BadRequestException('Вы не участвуете во встрече.');
        await tx.meetingParticipant.update({
          where: { id: member.id },
          data: { raisedHand: action === 'raise' },
        });
        return m.roomName;
      }
      if (!moderator)
        throw new ForbiddenException(
          'Действие доступно организатору или соорганизатору.',
        );
      if (
        ['end', 'cancel', 'cohost', 'participant', 'lock', 'unlock'].includes(
          action,
        ) &&
        !host
      )
        throw new ForbiddenException('Действие доступно организатору.');
      if (
        ['start', 'cancel'].includes(action) &&
        m.status !== 'scheduled' &&
        !(action === 'start' && m.status === 'live')
      )
        throw new ConflictException('Встреча уже началась или завершилась.');
      if (
        !['start', 'cancel'].includes(action) &&
        m.status !== 'live' &&
        !(action === 'end' && m.status === 'completed')
      )
        throw new ConflictException('Встреча не идёт.');
      if (
        ['admit', 'remove', 'mute', 'cohost', 'participant'].includes(action)
      ) {
        const target = m.participants.find((p) => p.userId === personId);
        if (!target || personId === m.organizerId || personId === userId)
          throw new BadRequestException(
            'Нельзя выполнить действие с этим участником.',
          );
        if (!host && target.role !== 'participant')
          throw new ForbiddenException(
            'Соорганизатор управляет только обычными участниками.',
          );
        if (action === 'admit')
          await tx.meetingParticipant.update({
            where: { id: target.id },
            data: { admitted: true, requestedAt: null, removed: false },
          });
        if (action === 'remove')
          await tx.meetingParticipant.update({
            where: { id: target.id },
            data: { admitted: false, removed: true, requestedAt: null },
          });
        if (['cohost', 'participant'].includes(action))
          await tx.meetingParticipant.update({
            where: { id: target.id },
            data: { role: action },
          });
      }
      if (action === 'start')
        await tx.meeting.update({
          where: { id },
          data: { status: 'live', startedAt: m.startedAt || new Date() },
        });
      if (action === 'end' || action === 'cancel')
        await tx.meeting.update({
          where: { id },
          data: {
            status: action === 'end' ? 'completed' : 'cancelled',
            endedAt: new Date(),
          },
        });
      if (action === 'lock' || action === 'unlock')
        await tx.meeting.update({
          where: { id },
          data: { locked: action === 'lock' },
        });
      if (action === 'record') {
        if (
          !(await tx.meetingRecording.findFirst({
            where: {
              meetingId: id,
              status: { in: ['starting', 'recording', 'stopping'] },
            },
          }))
        )
          await tx.meetingRecording.create({ data: { meetingId: id } });
      }
      if (action === 'stop-record' || action === 'end')
        await tx.meetingRecording.updateMany({
          where: { meetingId: id, status: { in: ['starting', 'recording'] } },
          data: { status: 'stopping', nextAttemptAt: new Date() },
        });
      return m.roomName;
    });
    if (['remove', 'mute', 'cohost', 'participant'].includes(action)) {
      const m = await this.prisma.meeting.findUniqueOrThrow({ where: { id } });
      await this.calls.request(room, '/participant', 'POST', {
        identity: personId,
        action: ['cohost', 'participant'].includes(action)
          ? 'permissions'
          : action,
        screenShare: action === 'cohost' || m.allowScreenShare,
      });
    }
    if (['end', 'cancel'].includes(action) && this.calls.configured) {
      await this.calls.request(room, '', 'DELETE');
      await this.prisma.meeting.update({
        where: { id },
        data: { roomClosed: true },
      });
    }
    return this.get(userId, workspaceId, id);
  }

  async notes(userId: string, workspaceId: string, id: string, notes: string) {
    const { moderator } = await this.access(userId, workspaceId, id);
    if (!moderator) throw new ForbiddenException();
    await this.prisma.meeting.update({ where: { id }, data: { notes } });
    return this.get(userId, workspaceId, id);
  }

  async transcript(
    userId: string,
    workspaceId: string,
    id: string,
    text: string,
  ) {
    await this.team.transaction(workspaceId, async (tx) => {
      const { access, moderator, meeting } = await this.access(
        userId,
        workspaceId,
        id,
        tx,
      );
      if (!access.canManage || !moderator) throw new ForbiddenException();
      if (meeting.status !== 'completed' || meeting.publishedAt)
        throw new ConflictException(
          'Расшифровка доступна после завершения, до публикации протокола.',
        );
      if (!text.trim()) throw new BadRequestException('Расшифровка пуста.');
      await tx.meeting.update({
        where: { id },
        data: {
          transcript: text.trim(),
          transcriptSource: 'manual',
          analysis: Prisma.DbNull,
          analysisStatus: 'queued',
          analysisRevision: { increment: 1 },
          analysisError: null,
          processingUntil: null,
        },
      });
    });
    return this.get(userId, workspaceId, id);
  }

  async publish(
    userId: string,
    workspaceId: string,
    id: string,
    dto: PublishProtocolDto,
  ) {
    await this.team.transaction(workspaceId, async (tx) => {
      const {
        meeting: m,
        access,
        moderator,
      } = await this.access(userId, workspaceId, id, tx);
      if (!access.canManage || !moderator)
        throw new ForbiddenException(
          'Протокол подтверждает руководитель встречи.',
        );
      if (m.publishedAt) return;
      if (m.analysisStatus !== 'draft' || m.analysisRevision !== dto.revision)
        throw new ConflictException('Протокол изменился. Обновите страницу.');
      if (!dto.summary.trim())
        throw new BadRequestException('Заполните итог встречи.');
      for (const task of dto.tasks) {
        if (!task.title.trim() || !task.successCriteria.trim())
          throw new BadRequestException(
            'Заполните название и критерий результата задачи.',
          );
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(task.startDate) ||
          !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)
        )
          throw new BadRequestException('Укажите даты без времени.');
        const people = await tx.user.findMany({
          where: {
            id: { in: task.assigneeIds },
            OR: [
              { id: access.workspace.ownerId },
              { departments: { some: { departmentId: m.departmentId } } },
            ],
          },
          select: { id: true, email: true },
        });
        if (people.length !== task.assigneeIds.length)
          throw new BadRequestException(
            'Исполнитель не состоит в департаменте встречи.',
          );
        await this.tasks.createInTransaction(
          tx,
          userId,
          workspaceId,
          m.departmentId,
          {
            ...task,
            assignees: people.map((p) => ({
              email: p.email,
              departmentId: m.departmentId,
            })),
          },
          id,
        );
      }
      const analysis = parseMeetingAnalysis(JSON.stringify(m.analysis));
      await tx.meeting.update({
        where: { id },
        data: {
          publishedAt: new Date(),
          analysisStatus: 'published',
          analysis: {
            ...analysis,
            summary: dto.summary,
            decisions: dto.decisions,
            tasks: dto.tasks,
          } as unknown as Prisma.InputJsonValue,
        },
      });
      await this.notify(
        tx,
        m,
        m.participants.filter((p) => !p.removed).map((p) => p.userId),
        'MEETING_PROTOCOL',
      );
    });
    return this.get(userId, workspaceId, id);
  }

  async recordingUrl(
    userId: string,
    workspaceId: string,
    id: string,
    recordingId: string,
  ) {
    const { meeting } = await this.access(userId, workspaceId, id);
    const recording = meeting.recordings.find((r) => r.id === recordingId);
    if (!recording?.fileKey)
      throw new NotFoundException('Запись ещё не готова.');
    return this.calls.request<{ url: string }>(
      meeting.roomName,
      '/recordings/url',
      'POST',
      { key: recording.fileKey },
    );
  }

  async retryRecording(
    userId: string,
    workspaceId: string,
    id: string,
    recordingId: string,
  ) {
    const { meeting, moderator } = await this.access(userId, workspaceId, id);
    if (!moderator) throw new ForbiddenException();
    if (meeting.publishedAt)
      throw new ConflictException('Протокол уже опубликован.');
    const r = meeting.recordings.find((r) => r.id === recordingId);
    if (!r || r.status !== 'failed')
      throw new BadRequestException('Нет записи для повторной обработки.');
    await this.prisma.meetingRecording.update({
      where: { id: r.id },
      data: {
        status: r.fileKey ? 'transcribing' : 'stopping',
        attempts: 0,
        error: null,
        nextAttemptAt: new Date(),
        processingUntil: null,
        speechTaskId: null,
      },
    });
    return this.get(userId, workspaceId, id);
  }

  async prepare(userId: string, workspaceId: string, id: string) {
    const {
      meeting: m,
      access,
      host,
    } = await this.access(userId, workspaceId, id);
    if (!host || !access.canManage || m.status !== 'scheduled')
      throw new ForbiddenException(
        'Повестка готовится организатором до начала встречи.',
      );
    const previous = m.previousId
      ? (await this.access(userId, workspaceId, m.previousId)).meeting
      : null;
    const tasks = await this.prisma.task.findMany({
      where: {
        workspaceId,
        departments: { some: { departmentId: m.departmentId } },
        OR: [
          { status: { not: 'done' } },
          ...(previous ? [{ meetingId: previous.id }] : []),
        ],
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'desc' }],
      take: 100,
      select: {
        title: true,
        status: true,
        dueDate: true,
        successCriteria: true,
        assignees: { select: { name: true } },
      },
    });
    const result = await this.ai.prepareMeeting({
      title: m.title,
      objective: m.objective,
      agenda: m.agenda,
      date: m.startsAt,
      now: new Date(),
      department: m.department.name,
      previous: previous?.publishedAt ? previous.analysis : null,
      tasks,
    });
    // An explicit click applies the suggestion in the browser; never overwrite a concurrent edit.
    return result;
  }

  async event(event: { event?: string; room?: string; identity?: string }) {
    if (event.event !== 'participant_joined' || !event.room || !event.identity)
      return { ok: true };
    const m = await this.prisma.meeting.findUnique({
      where: { roomName: event.room },
    });
    if (!m) return { ok: true };
    let allowed = false;
    let screenShare = false;
    try {
      const { member, moderator, access } = await this.access(
        event.identity,
        m.workspaceId,
        m.id,
      );
      const active = await this.prisma.subscription.count({
        where: {
          userId: access.workspace.ownerId,
          activeUntil: { gt: new Date() },
        },
      });
      allowed =
        active > 0 &&
        m.status === 'live' &&
        (moderator ||
          (!m.locked && (!m.waitingRoom || Boolean(member?.admitted))));
      screenShare = allowed && (moderator || m.allowScreenShare);
    } catch {
      /* Removed membership or invitation must revoke reconnects as well. */
    }
    // A still-valid token can predate a role change while the user was offline.
    await this.calls.request(m.roomName, '/participant', 'POST', {
      identity: event.identity,
      action: allowed ? 'permissions' : 'remove',
      screenShare,
    });
    return { ok: true };
  }
}
