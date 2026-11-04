import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { MeetingGuest } from '../../generated/prisma/client.js';
import type { TeamService } from '../team/team.service.js';
import type { CallsClient } from './calls.client.js';
import { GuestMeetingsService } from './guest-meetings.service.js';
import { GuestMeetingsController } from './guest-meetings.controller.js';
import { MeetingsController } from './meetings.controller.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { BillingGuard } from '../billing/billing.guard.js';

const token = randomUUID();
const guestKey = randomUUID();
const otherKey = randomUUID();

function fixture() {
  const meeting = {
    id: 'meeting1',
    workspaceId: 'workspace1',
    workspace: { ownerId: 'owner1' },
    title: 'Встреча',
    startsAt: new Date(),
    startedAt: new Date(),
    duration: 30,
    status: 'live',
    locked: false,
    roomClosed: false,
    roomName: 'meeting_room',
    waitingRoom: true,
    muteOnEntry: true,
    allowScreenShare: false,
    notes: 'Private notes',
    transcript: 'Private transcript',
    analysis: { private: true },
  };
  const guests: MeetingGuest[] = [];
  const prisma = {
    meeting: { findUnique: vi.fn().mockResolvedValue(meeting) },
    subscription: { count: vi.fn().mockResolvedValue(1) },
    meetingGuest: {
      findUnique: vi.fn(
        async ({ where }) =>
          guests.find(
            (g) =>
              g.sessionHash === where.meetingId_sessionHash.sessionHash &&
              g.meetingId === where.meetingId_sessionHash.meetingId,
          ) ?? null,
      ),
      create: vi.fn(async ({ data }) => {
        const guest = {
          removed: false,
          raisedHand: false,
          createdAt: new Date(),
          ...data,
        } as MeetingGuest;
        guests.push(guest);
        return guest;
      }),
      findMany: vi.fn(async () =>
        guests
          .filter((g) => g.admitted && !g.removed)
          .map((g) => ({ id: g.id, name: g.name, raisedHand: g.raisedHand })),
      ),
      update: vi.fn(async ({ where, data }) =>
        Object.assign(
          guests.find((g) => g.id === where.id)!,
          data,
        ),
      ),
    },
    meetingParticipant: {
      findMany: vi
        .fn()
        .mockResolvedValue([
          {
            userId: 'host1',
            role: 'host',
            admitted: true,
            raisedHand: false,
            user: { name: 'Организатор' },
          },
        ]),
    },
    meetingRecording: { count: vi.fn().mockResolvedValue(1) },
  };
  let pending = Promise.resolve<unknown>(undefined);
  const team = {
    transaction: vi.fn((_workspaceId, action) => {
      const next = pending.then(() => action(prisma));
      pending = next.catch(() => undefined);
      return next;
    }),
  };
  const calls = {
    configured: true,
    request: vi
      .fn()
      .mockResolvedValue({
        token: 'livekit-token',
        url: 'wss://calls.example',
      }),
  };
  const service = new GuestMeetingsService(
    prisma as unknown as PrismaService,
    team as unknown as TeamService,
    calls as unknown as CallsClient,
  );
  return { service, meeting, guests, prisma, calls };
}

describe('Public guest meeting access', () => {
  it('keeps existing meeting/CRM routes behind authentication and billing', () => {
    expect(Reflect.getMetadata('__guards__', MeetingsController)).toEqual([
      JwtAuthGuard,
      BillingGuard,
    ]);
    expect(
      Reflect.getMetadata('__guards__', GuestMeetingsController),
    ).toBeUndefined();
  });

  it('returns minimal info without participants, internal data or credentials before admission', async () => {
    const f = fixture();
    const state = await f.service.get(token);
    expect(state).toMatchObject({
      title: 'Встреча',
      identity: null,
      guestState: 'none',
      participants: [],
      recordingActive: false,
    });
    for (const field of [
      'workspaceId',
      'roomName',
      'workspace',
      'notes',
      'transcript',
      'analysis',
      'tasks',
      'people',
      'recordings',
      'sessionHash',
    ])
      expect(state).not.toHaveProperty(field);
    expect(f.prisma.meetingParticipant.findMany).not.toHaveBeenCalled();
  });

  it('creates one waiting-room guest for concurrent/repeated requests and stores only a hash', async () => {
    const f = fixture();
    const results = await Promise.all([
      f.service.join(token, { guestKey, name: 'Анна' }),
      f.service.join(token, { guestKey, name: 'Другое имя' }),
    ]);
    expect(f.prisma.meetingGuest.create).toHaveBeenCalledOnce();
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      waiting: true,
      identity: expect.stringMatching(/^guest_/),
    });
    expect(f.guests[0].name).toBe('Анна');
    expect(f.guests[0].sessionHash).toBe(
      createHash('sha256').update(guestKey).digest('hex'),
    );
    expect(JSON.stringify(f.guests)).not.toContain(guestKey);
    expect(f.calls.request).not.toHaveBeenCalled();
    expect(await f.service.get(token, guestKey)).toMatchObject({
      guestState: 'waiting',
      participants: [],
    });
    expect(await f.service.get(token, otherKey)).toMatchObject({
      identity: null,
      guestState: 'none',
      participants: [],
    });
  });

  it('issues a token after host admission and exposes only the live roster and recording notice', async () => {
    const f = fixture();
    const waiting = await f.service.join(token, { guestKey, name: 'Анна' });
    f.guests[0].admitted = true;
    expect(
      await f.service.join(token, { guestKey, name: 'Анна' }),
    ).toMatchObject({
      waiting: false,
      identity: waiting.identity,
      token: 'livekit-token',
    });
    expect(f.calls.request).toHaveBeenCalledWith(
      'meeting_room',
      '/token',
      'POST',
      { identity: waiting.identity, name: 'Анна', screenShare: false },
    );
    const state = await f.service.get(token, guestKey);
    expect(state).toMatchObject({
      guestState: 'admitted',
      recordingActive: true,
    });
    expect(f.prisma.meetingRecording.count).toHaveBeenCalledWith({
      where: { meetingId: 'meeting1', status: 'recording', error: null },
    });
    expect(state.participants).toHaveLength(2);
    expect(JSON.stringify(state)).not.toContain('sessionHash');
    expect(JSON.stringify(state)).not.toContain('Private');
  });

  it('does not duplicate the guest when a token response is lost and join is retried', async () => {
    const f = fixture();
    f.meeting.waitingRoom = false;
    f.calls.request.mockRejectedValueOnce(new Error('Network error'));
    await expect(
      f.service.join(token, { guestKey, name: 'Анна' }),
    ).rejects.toThrow('Network error');
    const identity = f.guests[0].id;
    expect(
      await f.service.join(token, { guestKey, name: 'Анна' }),
    ).toMatchObject({ waiting: false, identity });
    expect(f.prisma.meetingGuest.create).toHaveBeenCalledOnce();
    expect(f.calls.request).toHaveBeenCalledTimes(2);
  });

  it.each(['removed', 'expired'] as const)(
    'never revives a %s session by retrying the same guest key',
    async (reason) => {
      const f = fixture();
      await f.service.join(token, { guestKey, name: 'Анна' });
      if (reason === 'removed') f.guests[0].removed = true;
      else f.guests[0].expiresAt = new Date(0);
      await expect(
        f.service.join(token, { guestKey, name: 'Анна' }),
      ).rejects.toThrow();
      expect(await f.service.get(token, guestKey)).toMatchObject({
        guestState: reason,
        participants: [],
      });
      expect(f.prisma.meetingGuest.create).toHaveBeenCalledOnce();
      expect(f.calls.request).not.toHaveBeenCalled();
    },
  );

  it.each([
    'locked',
    'scheduled',
    'completed',
    'cancelled',
    'closed',
    'unpaid',
  ])('refuses joining a %s meeting', async (reason) => {
    const f = fixture();
    if (reason === 'locked') f.meeting.locked = true;
    else if (reason === 'closed') f.meeting.roomClosed = true;
    else if (reason === 'unpaid')
      f.prisma.subscription.count.mockResolvedValue(0);
    else f.meeting.status = reason;
    await expect(
      f.service.join(token, { guestKey, name: 'Анна' }),
    ).rejects.toThrow();
    expect(f.prisma.meetingGuest.create).not.toHaveBeenCalled();
    expect(f.calls.request).not.toHaveBeenCalled();
  });

  it('allows only raising/lowering the admitted guest own hand', async () => {
    const f = fixture();
    await f.service.join(token, { guestKey, name: 'Анна' });
    await expect(
      f.service.action(token, { guestKey, action: 'raise' }),
    ).rejects.toThrow('Дождитесь');
    f.guests[0].admitted = true;
    await expect(
      f.service.action(token, { guestKey: otherKey, action: 'raise' }),
    ).rejects.toThrow();
    await expect(
      f.service.action(token, { guestKey, action: 'end' }),
    ).rejects.toThrow();
    await f.service.action(token, { guestKey, action: 'raise' });
    expect(f.guests[0].raisedHand).toBe(true);
    await f.service.action(token, { guestKey, action: 'lower' });
    expect(f.guests[0].raisedHand).toBe(false);
    f.guests[0].removed = true;
    await expect(
      f.service.action(token, { guestKey, action: 'raise' }),
    ).rejects.toThrow();
  });

  it('rejects invalid tokens/credentials and empty names before creating sessions', async () => {
    const f = fixture();
    await expect(f.service.get('meeting1')).rejects.toThrow(
      'Встреча не найдена',
    );
    await expect(f.service.get(token, 'bad-key')).rejects.toThrow(
      'Некорректный ключ',
    );
    await expect(
      f.service.join(token, { guestKey, name: '   ' }),
    ).rejects.toThrow('Укажите имя');
    expect(f.prisma.meetingGuest.create).not.toHaveBeenCalled();
  });
});
