import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { MeetingsWorker } from './meetings.worker.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { CallsClient } from './calls.client.js';
import type { GigachatService } from '../gigachat/gigachat.service.js';
import type { ConfigService } from '@nestjs/config';

function fixture(status = 'completed') {
  const meeting: any = {
    id: 'm1',
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
  };
  const db: any = {
    meetingRecording: {
      updateMany: vi.fn(async ({ where, data }) => {
        if (
          where.status &&
          (typeof where.status === 'string'
            ? recording.status !== where.status
            : !where.status.in.includes(recording.status))
        )
          return { count: 0 };
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
  const make = () =>
    new MeetingsWorker(
      db as PrismaService,
      calls as unknown as CallsClient,
      {} as GigachatService,
      {} as ConfigService,
    );
  return { meeting, recording, db, calls, make };
}
describe('Meeting processing recovery', () => {
  it('keeps STARTING until Egress confirms capture, and does not submit duplicate starts', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'starting',
      fileKey: null,
      egressId: null,
    });
    f.calls.request
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'eg1', status: 0 });
    await f.make().recording('r1');
    expect(f.recording.status).toBe('starting');
    expect(f.recording.egressId).toBe('eg1');
    f.calls.request.mockResolvedValueOnce([{ id: 'eg1', status: 1 }]);
    await f.make().recording('r1');
    expect(f.recording.status).toBe('recording');
    expect(
      f.calls.request.mock.calls.filter(
        (c) => c[1] === '/recordings' && c[2] === 'POST',
      ),
    ).toHaveLength(1);
  });
  it('shows an initial start failure, then clears it on recovery and restores frequent polling', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'starting',
      fileKey: null,
      egressId: null,
    });
    f.calls.request
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('Secret upstream detail'));
    await f.make().recording('r1');
    expect(f.recording.status).toBe('starting');
    expect(f.recording.error).toContain('Не удалось запустить запись.');
    expect(f.recording.error).not.toContain('Secret upstream detail');
    Object.assign(f.recording, { attempts: 4 });
    f.calls.request
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'eg1', status: 1 });
    await f.make().recording('r1');
    expect(f.recording.status).toBe('recording');
    expect(f.recording.error).toBeNull();
    expect(f.recording.attempts).toBe(0);
    expect(
      f.recording.nextAttemptAt.getTime() - Date.now(),
    ).toBeLessThanOrEqual(15_000);
  });
  it('does not replace a concurrent stop request when Egress acknowledges a start', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'starting',
      fileKey: null,
      egressId: null,
    });
    f.calls.request
      .mockResolvedValueOnce([])
      .mockImplementationOnce(async () => {
        f.recording.status = 'stopping';
        return { id: 'eg1', status: 1 };
      });
    await f.make().recording('r1');
    expect(f.recording.status).toBe('stopping');
    expect(f.recording.egressId).toBe('eg1');
  });
  it('does not interpret a failed Egress as active capture', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'starting',
      fileKey: null,
      egressId: null,
    });
    f.calls.request
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ id: 'eg1', status: 5 });
    await f.make().recording('r1');
    expect(f.recording.status).toBe('starting');
    expect(f.recording.error).toContain('Не удалось запустить запись.');
  });
  it('continues through saving and recognition after a complete Egress output', async () => {
    const f = fixture();
    Object.assign(f.recording, {
      status: 'stopping',
      fileKey: null,
      egressId: 'eg1',
    });
    f.calls.request
      .mockResolvedValueOnce([{ id: 'eg1', status: 2 }])
      .mockResolvedValueOnce([
        {
          id: 'eg1',
          status: 3,
          files: [{ filename: 'meetings/meeting_one/done.mp4', size: '1000' }],
        },
      ])
      .mockResolvedValueOnce({ text: 'Итог встречи.' });
    await f.make().recording('r1');
    expect(f.recording.status).toBe('ready');
    expect(f.meeting.analysisStatus).toBe('queued');
    expect(f.recording.fileKey).toBe('meetings/meeting_one/done.mp4');
  });
  it('retries a completed Egress without a file instead of polling forever without an error', async () => {
    const f = fixture('live');
    Object.assign(f.recording, {
      status: 'recording',
      fileKey: null,
      egressId: 'eg1',
    });
    f.calls.request.mockResolvedValueOnce([
      { id: 'eg1', status: 3, files: [] },
    ]);
    await f.make().recording('r1');
    expect(f.recording.attempts).toBe(1);
    expect(f.recording.error).toContain(
      'Не удалось проверить состояние записи.',
    );
  });
  it('resumes upload, task and result across worker instances without needing Egress again', async () => {
    const f = fixture();
    f.calls.request
      .mockResolvedValueOnce({ uploadId: 'uploaded' })
      .mockResolvedValueOnce({ taskId: 'recognition' })
      .mockResolvedValueOnce({ taskId: 'recognition', text: 'Обсудили план.' });
    await f.make().recording('r1');
    expect(f.recording.uploadId).toBe('uploaded');
    await f.make().recording('r1');
    expect(f.recording.speechTaskId).toBe('recognition');
    await f.make().recording('r1');
    expect(f.recording.status).toBe('ready');
    expect(f.meeting.analysisStatus).toBe('queued');
    expect(
      f.calls.request.mock.calls.every(
        (c: any[]) => c[1] === '/recordings/transcribe',
      ),
    ).toBe(true);
    expect(f.calls.request.mock.calls[2][3]).toMatchObject({
      uploadId: 'uploaded',
      taskId: 'recognition',
    });
  });
  it('queues a transcript when a meeting ends after the recording has already finished', async () => {
    const f = fixture('live');
    f.calls.request.mockResolvedValue({ text: 'Итог' });
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
    f.calls.request.mockResolvedValue({ text: 'Автоматическая версия' });
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
