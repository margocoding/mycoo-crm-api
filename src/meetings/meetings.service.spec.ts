import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { MeetingsService } from './meetings.service.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { TeamService } from '../team/team.service.js';
import type { TasksService } from '../tasks/tasks.service.js';
import type { CallsClient } from './calls.client.js';
import type { ConfigService } from '@nestjs/config';
import type { GigachatService } from '../gigachat/gigachat.service.js';

function fixture() {
  const meeting = {
    id: 'meeting1',
    workspaceId: 'workspace1',
    roomName: 'meeting_room',
    status: 'live',
    locked: false,
    waitingRoom: true,
    allowScreenShare: false,
  };
  const prisma = {
    meeting: { findUnique: vi.fn().mockResolvedValue(meeting) },
    subscription: { count: vi.fn().mockResolvedValue(1) },
  };
  const calls = { request: vi.fn().mockResolvedValue({ ok: true }) };
  const service = new MeetingsService(
    prisma as unknown as PrismaService,
    {} as TeamService,
    {} as TasksService,
    calls as unknown as CallsClient,
    {} as ConfigService,
    {} as GigachatService,
  );
  const access = vi.spyOn(service, 'access').mockResolvedValue({
    meeting,
    member: { admitted: true },
    moderator: false,
    access: { workspace: { ownerId: 'owner1' } },
  } as any);
  const event = {
    event: 'participant_joined',
    room: meeting.roomName,
    identity: 'user1',
  };
  return { service, calls, prisma, access, event, meeting };
}

describe('LiveKit reconnect authorization', () => {
  it('replaces stale cohost token permissions with the current participant permissions', async () => {
    const f = fixture();
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
      'meeting_room',
      '/participant',
      'POST',
      { identity: 'user1', action: 'permissions', screenShare: false },
    );
  });
  it('keeps screen sharing available to a current moderator', async () => {
    const f = fixture();
    f.access.mockResolvedValue({
      meeting: { allowScreenShare: false },
      moderator: true,
      access: { workspace: { ownerId: 'owner1' } },
    } as any);
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledWith(
      'meeting_room',
      '/participant',
      'POST',
      { identity: 'user1', action: 'permissions', screenShare: true },
    );
  });
  it('removes a reconnecting user whose invitation was revoked', async () => {
    const f = fixture();
    f.access.mockRejectedValue(new Error('Removed invitation'));
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
      'meeting_room',
      '/participant',
      'POST',
      { identity: 'user1', action: 'remove', screenShare: false },
    );
  });
  it('removes a reconnecting participant after the subscription expires', async () => {
    const f = fixture();
    f.prisma.subscription.count.mockResolvedValue(0);
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
      'meeting_room',
      '/participant',
      'POST',
      { identity: 'user1', action: 'remove', screenShare: false },
    );
  });
});

describe('Guest LiveKit reconnect authorization', () => {
  function guestFixture() {
    const f = fixture();
    f.event.identity = 'guest_123';
    const guest = {
      id: f.event.identity,
      meetingId: f.meeting.id,
      admitted: true,
      removed: false,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const extra = {
      workspace: {
        findUnique: vi.fn().mockResolvedValue({ ownerId: 'owner1' }),
      },
      meetingGuest: { findFirst: vi.fn().mockResolvedValue(guest) },
    };
    Object.assign(f.prisma, extra);
    return { ...f, ...extra, guest };
  }

  it('validates a guest independently of CRM membership and applies current screen-share permissions', async () => {
    const f = guestFixture();
    await f.service.event(f.event);
    expect(f.access).not.toHaveBeenCalled();
    expect(f.meetingGuest.findFirst).toHaveBeenCalledWith({
      where: { id: 'guest_123', meetingId: 'meeting1' },
    });
    expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
      'meeting_room',
      '/participant',
      'POST',
      {
        identity: 'guest_123',
        action: 'permissions',
        screenShare: false,
      },
    );
  });

  it.each([
    'removed',
    'expired',
    'waiting',
    'missing',
    'locked',
    'completed',
    'unpaid',
    'closed',
  ])(
    'revokes a still-valid LiveKit token for a %s guest/meeting',
    async (reason) => {
      const f = guestFixture();
      if (reason === 'removed') f.guest.removed = true;
      if (reason === 'expired') f.guest.expiresAt = new Date(0);
      if (reason === 'waiting') f.guest.admitted = false;
      if (reason === 'missing')
        f.meetingGuest.findFirst.mockResolvedValue(null);
      if (reason === 'locked') f.meeting.locked = true;
      if (reason === 'completed') f.meeting.status = 'completed';
      if (reason === 'closed') Object.assign(f.meeting, { roomClosed: true });
      if (reason === 'unpaid') f.prisma.subscription.count.mockResolvedValue(0);
      await f.service.event(f.event);
      expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
        'meeting_room',
        '/participant',
        'POST',
        {
          identity: 'guest_123',
          action: 'remove',
          screenShare: false,
        },
      );
    },
  );
});

describe('Host guest moderation', () => {
  function hostFixture() {
    const guest = {
      id: 'guest_123',
      admitted: false,
      removed: false,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const meeting = {
      id: 'meeting1',
      roomName: 'room',
      status: 'live',
      organizerId: 'host1',
      allowScreenShare: false,
      participants: [],
      guests: [guest],
    };
    const prisma = {
      meeting: { findUniqueOrThrow: vi.fn().mockResolvedValue(meeting) },
      meetingGuest: { update: vi.fn().mockResolvedValue(guest) },
    };
    const calls = { request: vi.fn().mockResolvedValue({ ok: true }) };
    const team = { transaction: vi.fn((_workspace, action) => action(prisma)) };
    const service = new MeetingsService(
      prisma as unknown as PrismaService,
      team as unknown as TeamService,
      {} as TasksService,
      calls as unknown as CallsClient,
      {} as ConfigService,
      {} as GigachatService,
    );
    const permissions = { meeting, host: true, moderator: true };
    vi.spyOn(service, 'access').mockImplementation(
      async () => permissions as any,
    );
    vi.spyOn(service, 'get').mockResolvedValue({} as any);
    return { service, calls, prisma, guest, meeting, permissions };
  }

  it('admits and removes guests using their separate identity', async () => {
    const f = hostFixture();
    await f.service.action('host1', 'workspace1', 'meeting1', {
      action: 'admit',
      personId: 'guest_123',
    });
    expect(f.prisma.meetingGuest.update).toHaveBeenCalledWith({
      where: { id: 'guest_123' },
      data: { admitted: true, requestedAt: null },
    });
    await f.service.action('host1', 'workspace1', 'meeting1', {
      action: 'remove',
      personId: 'guest_123',
    });
    expect(f.prisma.meetingGuest.update).toHaveBeenCalledWith({
      where: { id: 'guest_123' },
      data: {
        admitted: false,
        removed: true,
        requestedAt: null,
        raisedHand: false,
      },
    });
    expect(f.calls.request).toHaveBeenCalledWith(
      'room',
      '/participant',
      'POST',
      { identity: 'guest_123', action: 'remove', screenShare: false },
    );
  });

  it('rejects guest promotion, out-of-meeting guests and revoked admission', async () => {
    const f = hostFixture();
    await expect(
      f.service.action('host1', 'workspace1', 'meeting1', {
        action: 'cohost',
        personId: 'guest_123',
      }),
    ).rejects.toThrow();
    await expect(
      f.service.action('host1', 'workspace1', 'meeting1', {
        action: 'admit',
        personId: 'guest_other',
      }),
    ).rejects.toThrow();
    f.guest.removed = true;
    await expect(
      f.service.action('host1', 'workspace1', 'meeting1', {
        action: 'admit',
        personId: 'guest_123',
      }),
    ).rejects.toThrow();
    expect(f.prisma.meetingGuest.update).not.toHaveBeenCalled();
    expect(f.calls.request).not.toHaveBeenCalled();
  });

  it('requires moderator permissions to admit a guest', async () => {
    const f = hostFixture();
    f.permissions.host = false;
    f.permissions.moderator = false;
    await expect(
      f.service.action('user1', 'workspace1', 'meeting1', {
        action: 'admit',
        personId: 'guest_123',
      }),
    ).rejects.toThrow();
    expect(f.prisma.meetingGuest.update).not.toHaveBeenCalled();
  });
});
