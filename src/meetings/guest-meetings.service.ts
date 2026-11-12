import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import { createHash, randomUUID } from 'node:crypto';
import type { MeetingGuest, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { TeamService } from '../team/team.service.js';
import { CallsClient } from './calls.client.js';
import type {
  GuestMeetingActionDto,
  GuestMeetingJoinDto,
} from './meetings.dto.js';

const meetingSelect = {
  id: true,
  workspaceId: true,
  workspace: { select: { ownerId: true, deletedAt: true } },
  title: true,
  startsAt: true,
  startedAt: true,
  duration: true,
  status: true,
  locked: true,
  roomClosed: true,
  roomName: true,
  waitingRoom: true,
  muteOnEntry: true,
  allowScreenShare: true,
} as const;

type GuestMeeting = Prisma.MeetingGetPayload<{ select: typeof meetingSelect }>;
const sessionLifetime = 24 * 60 * 60 * 1000;

@Injectable()
export class GuestMeetingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly team: TeamService,
    private readonly calls: CallsClient,
  ) {}

  private hash(key: string) {
    if (!isUUID(key, '4'))
      throw new BadRequestException('Некорректный ключ гостевой сессии.');
    return createHash('sha256').update(key.toLowerCase()).digest('hex');
  }

  private async meeting(
    token: string,
    db: Prisma.TransactionClient = this.prisma,
  ) {
    if (!isUUID(token, '4')) throw new NotFoundException('Встреча не найдена.');
    const meeting = await db.meeting.findUnique({
      where: { guestInviteToken: token.toLowerCase() },
      select: meetingSelect,
    });
    if (!meeting || meeting.workspace.deletedAt)
      throw new NotFoundException('Встреча не найдена.');
    if (
      !(await db.subscription.count({
        where: {
          userId: meeting.workspace.ownerId,
          activeUntil: { gt: new Date() },
        },
      }))
    )
      throw new ForbiddenException('Встречи компании временно недоступны.');
    return meeting;
  }

  private live(meeting: GuestMeeting, entering = true) {
    if (meeting.status !== 'live' || meeting.roomClosed)
      throw new ConflictException(
        meeting.status === 'scheduled'
          ? 'Организатор ещё не начал встречу.'
          : 'Встреча завершена.',
      );
    if (entering && meeting.locked)
      throw new ForbiddenException('Вход во встречу закрыт организатором.');
  }

  private usable(guest: MeetingGuest) {
    if (guest.removed) throw new ForbiddenException('Вы удалены из встречи.');
    if (guest.expiresAt.getTime() <= Date.now())
      throw new ForbiddenException(
        'Гостевая сессия истекла. Откройте ссылку заново.',
      );
  }

  async get(token: string, guestKey?: string) {
    const sessionHash =
      guestKey === undefined ? undefined : this.hash(guestKey);
    const meeting = await this.meeting(token);
    const guest = sessionHash
      ? await this.prisma.meetingGuest.findUnique({
          where: {
            meetingId_sessionHash: { meetingId: meeting.id, sessionHash },
          },
        })
      : null;
    const guestState = !guest
      ? 'none'
      : guest.removed
        ? 'removed'
        : guest.expiresAt.getTime() <= Date.now()
          ? 'expired'
          : guest.admitted
            ? 'admitted'
            : 'waiting';
    const inRoom =
      guestState === 'admitted' &&
      meeting.status === 'live' &&
      !meeting.roomClosed;
    const [members, guests, recordings] = inRoom
      ? await Promise.all([
          this.prisma.meetingParticipant.findMany({
            where: { meetingId: meeting.id, removed: false },
            select: {
              userId: true,
              role: true,
              admitted: true,
              raisedHand: true,
              user: { select: { name: true } },
            },
          }),
          this.prisma.meetingGuest.findMany({
            where: {
              meetingId: meeting.id,
              removed: false,
              admitted: true,
              expiresAt: { gt: new Date() },
            },
            select: { id: true, name: true, raisedHand: true },
          }),
          this.prisma.meetingRecording.count({
            where: {
              meetingId: meeting.id,
              status: 'recording',
              error: null,
            },
          }),
        ])
      : [[], [], 0];
    // This projection deliberately excludes company data, notes, protocols and recordings.
    return {
      id: meeting.id,
      title: meeting.title,
      startsAt: meeting.startsAt,
      startedAt: meeting.startedAt,
      duration: meeting.duration,
      status: meeting.status,
      waitingRoom: meeting.waitingRoom,
      locked: meeting.locked,
      muteOnEntry: meeting.muteOnEntry,
      allowScreenShare: meeting.allowScreenShare,
      callsAvailable: this.calls.configured,
      identity: guest?.id ?? null,
      guestState,
      recordingActive: recordings > 0,
      participants: [
        ...members.map((p) => ({
          personId: p.userId,
          name: p.user.name || 'Участник',
          role: p.role,
          admitted: p.admitted,
          removed: false,
          raisedHand: p.raisedHand,
          isGuest: false,
        })),
        ...guests.map((p) => ({
          personId: p.id,
          name: p.name,
          role: 'participant',
          admitted: true,
          removed: false,
          raisedHand: p.raisedHand,
          isGuest: true,
        })),
      ],
    };
  }

  async join(token: string, dto: GuestMeetingJoinDto) {
    const sessionHash = this.hash(dto.guestKey);
    const name = dto.name.trim();
    if (!name || name.length > 80)
      throw new BadRequestException('Укажите имя (до 80 символов).');
    const { workspaceId } = await this.meeting(token);
    const result = await this.team.transaction(workspaceId, async (tx) => {
      // The workspace lock also serializes host removal/admission and duplicate join requests.
      const meeting = await this.meeting(token, tx);
      this.live(meeting);
      let guest = await tx.meetingGuest.findUnique({
        where: {
          meetingId_sessionHash: { meetingId: meeting.id, sessionHash },
        },
      });
      if (guest) this.usable(guest);
      else
        guest = await tx.meetingGuest.create({
          data: {
            id: 'guest_' + randomUUID(),
            meetingId: meeting.id,
            sessionHash,
            name,
            admitted: !meeting.waitingRoom,
            requestedAt: meeting.waitingRoom ? new Date() : null,
            expiresAt: new Date(Date.now() + sessionLifetime),
          },
        });
      return {
        waiting: !guest.admitted,
        identity: guest.id,
        name: guest.name,
        room: meeting.roomName,
        screenShare: meeting.allowScreenShare,
      };
    });
    if (result.waiting) return { waiting: true, identity: result.identity };
    return {
      waiting: false,
      identity: result.identity,
      ...(await this.calls.request<{ token: string; url: string }>(
        result.room,
        '/token',
        'POST',
        {
          identity: result.identity,
          name: result.name,
          screenShare: result.screenShare,
        },
      )),
    };
  }

  async action(token: string, dto: GuestMeetingActionDto) {
    if (!['raise', 'lower'].includes(dto.action))
      throw new ForbiddenException();
    const sessionHash = this.hash(dto.guestKey);
    const { workspaceId } = await this.meeting(token);
    await this.team.transaction(workspaceId, async (tx) => {
      const meeting = await this.meeting(token, tx);
      this.live(meeting, false);
      const guest = await tx.meetingGuest.findUnique({
        where: {
          meetingId_sessionHash: { meetingId: meeting.id, sessionHash },
        },
      });
      if (!guest) throw new ForbiddenException('Вы не участвуете во встрече.');
      this.usable(guest);
      if (!guest.admitted)
        throw new ForbiddenException('Дождитесь допуска во встречу.');
      await tx.meetingGuest.update({
        where: { id: guest.id },
        data: { raisedHand: dto.action === 'raise' },
      });
    });
    return this.get(token, dto.guestKey);
  }
}
