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
    id: 'meeting1', workspaceId: 'workspace1', roomName: 'meeting_room',
    status: 'live', locked: false, waitingRoom: true, allowScreenShare: false,
  };
  const prisma = {
    meeting: { findUnique: vi.fn().mockResolvedValue(meeting) },
    subscription: { count: vi.fn().mockResolvedValue(1) },
  };
  const calls = { request: vi.fn().mockResolvedValue({ ok: true }) };
  const service = new MeetingsService(
    prisma as unknown as PrismaService, {} as TeamService, {} as TasksService,
    calls as unknown as CallsClient, {} as ConfigService, {} as GigachatService,
  );
  const access = vi.spyOn(service, 'access').mockResolvedValue({
    meeting, member: { admitted: true }, moderator: false,
    access: { workspace: { ownerId: 'owner1' } },
  } as any);
  const event = { event: 'participant_joined', room: meeting.roomName, identity: 'user1' };
  return { service, calls, prisma, access, event };
}

describe('LiveKit reconnect authorization', () => {
  it('replaces stale cohost token permissions with the current participant permissions', async () => {
    const f = fixture();
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
      'meeting_room', '/participant', 'POST',
      { identity: 'user1', action: 'permissions', screenShare: false },
    );
  });
  it('keeps screen sharing available to a current moderator', async () => {
    const f = fixture();
    f.access.mockResolvedValue({
      meeting: { allowScreenShare: false }, moderator: true,
      access: { workspace: { ownerId: 'owner1' } },
    } as any);
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledWith(
      'meeting_room', '/participant', 'POST',
      { identity: 'user1', action: 'permissions', screenShare: true },
    );
  });
  it('removes a reconnecting user whose invitation was revoked', async () => {
    const f = fixture();
    f.access.mockRejectedValue(new Error('Removed invitation'));
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
      'meeting_room', '/participant', 'POST',
      { identity: 'user1', action: 'remove', screenShare: false },
    );
  });
  it('removes a reconnecting participant after the subscription expires', async () => {
    const f = fixture();
    f.prisma.subscription.count.mockResolvedValue(0);
    await f.service.event(f.event);
    expect(f.calls.request).toHaveBeenCalledExactlyOnceWith(
      'meeting_room', '/participant', 'POST',
      { identity: 'user1', action: 'remove', screenShare: false },
    );
  });
});
