import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MeetingsService } from './meetings.service.js';

function fixture() {
  const recording = {
    id: 'recording1',
    fileKey: 'meetings/room/a.mp4',
    shareTokenHash: null as string | null,
    shareExpiresAt: null as Date | null,
    createdAt: new Date(),
  };
  const meeting = {
    id: 'meeting1',
    organizerId: 'organizer',
    roomName: 'room',
    status: 'live',
    recordings: [recording],
    workspace: { deletedAt: null as Date | null },
  };
  const db = {
    meetingRecording: {
      update: vi.fn(async ({ data }) => Object.assign(recording, data)),
      findUnique: vi.fn(async ({ where }) =>
        where.shareTokenHash === recording.shareTokenHash
          ? { ...recording, meeting }
          : null,
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  const calls = {
    request: vi
      .fn()
      .mockResolvedValue({ url: 'https://media.example.test/temporary' }),
  };
  const service = new MeetingsService(
    db as never,
    {
      transaction: (_id: string, fn: (db: unknown) => unknown) => fn(db),
    } as never,
    {} as never,
    calls as never,
    {} as never,
    {} as never,
  );
  vi.spyOn(service, 'access').mockResolvedValue({
    meeting,
    moderator: true,
    host: true,
  } as never);
  vi.spyOn(service, 'get').mockResolvedValue({} as never);
  return { recording, meeting, db, calls, service };
}

describe('Recording ownership and safe guest sharing', () => {
  it.each(['owner', 'cohost', 'participant'])(
    'does not let %s record for the original organizer',
    async (user) => {
      const f = fixture();
      for (const action of ['record', 'stop-record'])
        await expect(
          f.service.action(user, 'workspace', 'meeting1', { action }),
        ).rejects.toMatchObject({ status: 403 });
      expect(f.db.meetingRecording.create).not.toHaveBeenCalled();
    },
  );
  it('can create a second fragment once the first is saved, without a duplicate active capture', async () => {
    const f = fixture();
    f.db.meetingRecording.findFirst
      .mockResolvedValueOnce({ status: 'stopping' })
      .mockResolvedValueOnce(null);
    await f.service.action('organizer', 'workspace', 'meeting1', {
      action: 'record',
    });
    expect(f.db.meetingRecording.create).not.toHaveBeenCalled();
    await f.service.action('organizer', 'workspace', 'meeting1', {
      action: 'record',
    });
    expect(f.db.meetingRecording.create).toHaveBeenCalledOnce();
  });
  it('issues one-recording expiring bearer links, stores only hashes, rotates and revokes them', async () => {
    const f = fixture();
    const first = await f.service.shareRecording(
      'organizer',
      'workspace',
      'meeting1',
      'recording1',
      true,
    );
    expect(first.token).toMatch(/^[a-f0-9]{64}$/);
    expect(f.recording.shareTokenHash).toBe(
      createHash('sha256').update(first.token!).digest('hex'),
    );
    expect(f.recording.shareTokenHash).not.toBe(first.token);
    const result = await f.service.sharedRecording(first.token!);
    expect(Object.keys(result).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'title',
      'url',
    ]);
    expect(f.calls.request).toHaveBeenCalledWith(
      'room',
      '/recordings/url',
      'POST',
      { key: 'meetings/room/a.mp4' },
    );
    await f.service.shareRecording(
      'organizer',
      'workspace',
      'meeting1',
      'recording1',
      true,
    );
    await expect(f.service.sharedRecording(first.token!)).rejects.toMatchObject(
      { status: 404 },
    );
    await f.service.shareRecording(
      'organizer',
      'workspace',
      'meeting1',
      'recording1',
      false,
    );
    expect(f.recording.shareTokenHash).toBeNull();
    expect(f.recording.shareExpiresAt).toBeNull();
  });
  it('rejects non-organizers, missing recordings, invalid, expired and deleted-workspace links', async () => {
    const f = fixture();
    await expect(
      f.service.shareRecording(
        'owner',
        'workspace',
        'meeting1',
        'recording1',
        true,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      f.service.shareRecording(
        'organizer',
        'workspace',
        'meeting1',
        'other',
        true,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(f.service.sharedRecording('malformed')).rejects.toMatchObject({
      status: 404,
    });
    const link = await f.service.shareRecording(
      'organizer',
      'workspace',
      'meeting1',
      'recording1',
      true,
    );
    f.recording.shareExpiresAt = new Date(0);
    await expect(f.service.sharedRecording(link.token!)).rejects.toMatchObject({
      status: 404,
    });
    f.recording.shareExpiresAt = new Date(Date.now() + 60_000);
    f.meeting.workspace.deletedAt = new Date();
    await expect(f.service.sharedRecording(link.token!)).rejects.toMatchObject({
      status: 404,
    });
    expect(f.calls.request).not.toHaveBeenCalled();
  });
});
