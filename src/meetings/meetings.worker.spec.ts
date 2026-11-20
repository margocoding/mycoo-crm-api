import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { usageFixture } from '../../test/usage.fixture.js';
import { describe, expect, it, vi } from 'vitest';
import { MeetingsWorker } from './meetings.worker.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CallsClient } from './calls.client.js';
import type { GigachatService } from '../gigachat/gigachat.service.js';
import type { ConfigService } from '@nestjs/config';

function fixture(status = 'completed') {
  const meeting: any = {
    id: 'm1',
    workspaceId: 'company',
    departmentId: 'department',
    organizerId: 'owner',
    roomName: 'meeting_one',
    status,
    transcript: '',
    transcriptSource: 'recording',
    publishedAt: null,
    analysisStatus: 'none',
  };
  const recording: any = {
    id: 'r1',
    meetingId: 'm1',
    status: 'transcribing',
    fileKey: 'meetings/meeting_one/recording.mp4',
    processingUntil: null,
    attempts: 0,
    uploadId: null,
    speechTaskId: null,
    transcript: null,
    sizeBytes: 1000n,
    durationSeconds: 60,
  };
  const db: any = {
    meetingRecording: {
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.OR &&
          recording.processingUntil &&
          recording.processingUntil > new Date()
        )
          return { count: 0 };
        Object.assign(recording, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }) => {
        Object.assign(recording, data);
        return recording;
      }),
      findUniqueOrThrow: vi.fn(async () => ({
        ...recording,
        meeting: { ...meeting },
      })),
    },
    $executeRawUnsafe: vi.fn(),
    meeting: {
      findUnique: vi.fn(async () => ({ workspaceId: 'company' })),
      findUniqueOrThrow: vi.fn(async () => ({
        ...meeting,
        recordings: [{ ...recording }],
      })),
      findMany: vi.fn(async ({ where }) =>
        where.status === 'completed' ? [{ id: 'm1' }] : [],
      ),
      update: vi.fn(async ({ data }) => {
        Object.assign(meeting, data);
        return meeting;
      }),
    },
  };
  db.$transaction = async (fn: any) => fn(db);
  const calls = { configured: false, request: vi.fn() };
  const usage = usageFixture();
  const make = () =>
    new MeetingsWorker(
      db as PrismaService,
      calls as unknown as CallsClient,
      {} as GigachatService,
      {} as ConfigService,
      usage,
    );
  return { meeting, recording, db, calls, usage, make };
}
describe('Meeting processing recovery', () => {
  it('does not contact recognition when the shared AI budget is exhausted', async () => {
    const f = fixture();
    f.calls.request.mockResolvedValue({ sizeBytes: 1000, audioSeconds: 60, provider: 'yandex' });
    vi.mocked(f.usage.reserve).mockRejectedValue(new HttpException({ code: 'USAGE_LIMIT_REACHED', message: 'Лимит бюджета.' }, 403));
    await f.make().recording('r1');
    expect(f.recording.status).toBe('failed');
    expect(f.recording.error).toBe('Лимит бюджета.');
    expect(f.calls.request.mock.calls.map(c => c[1])).toEqual(['/recordings/info']);
  });
  it('does not reserve recognition funds for a legacy file beyond the download ceiling', async () => {
    const f = fixture();
    f.calls.request.mockResolvedValue({ sizeBytes: 2_100_000_000, audioSeconds: 60, provider: 'yandex' });
    await f.make().recording('r1');
    expect(f.usage.reserve).not.toHaveBeenCalled();
    expect(f.calls.request.mock.calls.map(c => c[1])).toEqual(['/recordings/info']);
    expect(f.recording.sizeBytes).toBe(2_100_000_000n);
  });
  it('saves a stopped fragment before recognition so the scan can start the next one', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'stopping',
      fileKey: null,
      egressId: 'EG_one',
      stopRequestedAt: new Date(),
    });
    const completed = [
      {
        id: 'EG_one',
        status: 3,
        files: [{ filename: 'meetings/meeting_one/segment_r1.mp4' }],
      },
    ];
    f.calls.request.mockImplementation(async (_room, path) => path === '/recordings/info'
      ? { sizeBytes: 1000, audioSeconds: 60, provider: 'salute' } : completed);
    await f.make().recording('r1');
    expect(f.recording.status).toBe('transcribing');
    expect(f.calls.request).toHaveBeenCalledWith(
      'meeting_one',
      '/recordings/stop',
      'POST',
      { egressId: 'EG_one' },
    );
    expect(
      f.calls.request.mock.calls.some(
        (call) => call[1] === '/recordings/transcribe',
      ),
    ).toBe(false);
  });
  it('does not attach a stopped-before-start fragment to another recording', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'stopping',
      fileKey: null,
      egressId: null,
      stopRequestedAt: new Date(),
    });
    f.calls.request.mockResolvedValue([
      { id: 'EG_other', status: 3, files: [{ filename: 'other.mp4' }] },
    ]);
    await f.make().recording('r1');
    expect(f.recording.status).toBe('failed');
    expect(f.recording.fileKey).toBeNull();
    expect(f.calls.request).toHaveBeenCalledTimes(1);
  });
  it('bounds a stuck stopping state and keeps its Egress ID for recovery', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'stopping',
      fileKey: null,
      egressId: 'EG_one',
      stopRequestedAt: new Date(Date.now() - 6 * 60_000),
    });
    f.calls.request.mockResolvedValue([{ id: 'EG_one', status: 2, files: [] }]);
    await f.make().recording('r1');
    expect(f.recording.status).toBe('failed');
    expect(f.recording.egressId).toBe('EG_one');
    expect(f.recording.error).toContain('Сохранение записи затянулось');
  });
  it('does not claim capture forever when completed Egress has no file', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'recording',
      fileKey: null,
      egressId: 'EG_one',
      attempts: 5,
    });
    f.calls.request.mockResolvedValue([{ id: 'EG_one', status: 3, files: [] }]);
    await f.make().recording('r1');
    expect(f.recording.status).toBe('failed');
    expect(f.recording.fileKey).toBeNull();
  });
  it('disconnects removed members that are actually in the room, retaining everyone else', async () => {
    const f = fixture('live');
    f.db.meeting.findMany.mockResolvedValue([
      {
        id: 'm1',
        roomName: 'meeting_one',
        participants: [{ userId: 'removed' }],
        guests: [],
      },
    ]);
    f.calls.request.mockResolvedValue([
      { identity: 'removed' },
      { identity: 'active' },
    ]);
    await f.make().revokeRemovedParticipants();
    expect(f.calls.request).toHaveBeenCalledWith(
      'meeting_one',
      '/participant',
      'POST',
      { identity: 'removed', action: 'remove', screenShare: false },
    );
    expect(f.calls.request).toHaveBeenCalledTimes(2);
  });
  it('resumes upload, task and result across worker instances without needing Egress again', async () => {
    const f = fixture();
    const responses = [{ uploadId: 'uploaded' }, { taskId: 'recognition' }, { taskId: 'recognition', text: 'Обсудили план.' }];
    f.calls.request.mockImplementation(async (_room, path) => path === '/recordings/info'
      ? { sizeBytes: 1000, audioSeconds: 60, provider: 'salute' } : responses.shift());
    await f.make().recording('r1');
    expect(f.recording.uploadId).toBe('uploaded');
    await f.make().recording('r1');
    expect(f.recording.speechTaskId).toBe('recognition');
    await f.make().recording('r1');
    expect(f.recording.status).toBe('ready');
    expect(f.meeting.analysisStatus).toBe('queued');
    expect(
      f.calls.request.mock.calls.every(
        (c: any[]) => ['/recordings/info', '/recordings/transcribe'].includes(c[1]),
      ),
    ).toBe(true);
    expect(f.calls.request.mock.calls.filter(c => c[1] === '/recordings/transcribe')[2][3]).toMatchObject({
      uploadId: 'uploaded',
      taskId: 'recognition',
    });
  });
  it('queues a transcript when a meeting ends after the recording has already finished', async () => {
    const f = fixture('live');
    f.calls.request.mockImplementation(async (_room, path) => path === '/recordings/info'
      ? { sizeBytes: 1000, audioSeconds: 60, provider: 'salute' } : { taskId: 'recognized', text: 'Итог' });
    await f.make().recording('r1');
    expect(f.meeting.analysisStatus).toBe('none');
    f.meeting.status = 'completed';
    await f.make().run();
    expect(f.meeting.analysisStatus).toBe('queued');
    expect(f.meeting.transcript).toBe('Итог');
  });
  it('does not overwrite a manually corrected transcript', async () => {
    const f = fixture();
    f.meeting.transcriptSource = 'manual';
    f.meeting.transcript = 'Правка руководителя';
    f.calls.request.mockImplementation(async (_room, path) => path === '/recordings/info'
      ? { sizeBytes: 1000, audioSeconds: 60, provider: 'salute' } : { taskId: 'recognized', text: 'Автоматическая версия' });
    await f.make().recording('r1');
    expect(f.meeting.transcript).toBe('Правка руководителя');
  });
  it('retains provider task IDs after errors and stops after the bounded retry budget', async () => {
    const f = fixture();
    f.recording.attempts = 5;
    f.recording.speechTaskId = 'existing-task';
    f.calls.request.mockRejectedValue(new Error('provider failed'));
    await f.make().recording('r1');
    expect(f.recording.status).toBe('failed');
    expect(f.recording.speechTaskId).toBe('existing-task');
    expect(f.recording.processingUntil).toBeNull();
  });
  it('does not submit recognition while another process holds the recording lease', async () => {
    const f = fixture();
    f.recording.processingUntil = new Date(Date.now() + 60000);
    await f.make().recording('r1');
    expect(f.calls.request).not.toHaveBeenCalled();
  });
});
