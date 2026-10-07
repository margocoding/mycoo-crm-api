import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { PrismaService } from '../../prisma/prisma.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { GigachatService } from '../gigachat/gigachat.service.js';
import { CallsClient, type CallRecording } from './calls.client.js';
import type { MeetingAnalysis } from './meeting-analysis.js';

@Injectable()
export class MeetingsWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MeetingsWorker.name);
  private queue?: Queue;
  private worker?: Worker;
  private producer?: Redis;
  private consumer?: Redis;
  private closing = false;
  constructor(
    private readonly prisma: PrismaService,
    private readonly calls: CallsClient,
    private readonly ai: GigachatService,
    private readonly config: ConfigService,
  ) {}
  async onModuleInit() {
    const url = this.config.getOrThrow<string>('REDIS_URL');
    this.producer = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.consumer = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
    });
    for (const r of [this.producer, this.consumer])
      r.on('error', () => this.logger.warn('Meetings Redis unavailable'));
    this.queue = new Queue('meetings-processing', {
      connection: this.producer,
    });
    this.queue.on('error', () =>
      this.logger.warn('Meetings queue unavailable'),
    );
    this.worker = new Worker('meetings-processing', () => this.run(), {
      connection: this.consumer,
      concurrency: 1,
    });
    this.worker.on('error', () =>
      this.logger.warn('Meetings worker unavailable'),
    );
    this.worker.on('failed', () =>
      this.logger.warn('Meeting processing failed; persisted work retained'),
    );
    const schedule = () =>
      this.queue!.upsertJobScheduler(
        'scan',
        { every: 15000 },
        {
          name: 'scan',
          data: {},
          opts: { removeOnComplete: true, removeOnFail: 20 },
        },
      );
    this.producer.on('ready', () => {
      if (!this.closing)
        void schedule().catch(() =>
          this.logger.warn('Meetings schedule will recover on reconnect'),
        );
    });
    await this.queue.waitUntilReady();
    await this.worker.waitUntilReady();
    await schedule();
  }

  async run() {
    const now = new Date();
    // These DB leases also protect scans running in several API instances.
    if (this.calls.configured) {
      const recordings = await this.prisma.meetingRecording.findMany({
        where: {
          status: { in: ['starting', 'recording', 'stopping', 'transcribing'] },
          nextAttemptAt: { lte: now },
          OR: [{ processingUntil: null }, { processingUntil: { lt: now } }],
        },
        take: 20,
        orderBy: { nextAttemptAt: 'asc' },
      });
      for (const row of recordings) await this.recording(row.id);
      const ended = await this.prisma.meeting.findMany({
        where: {
          status: { in: ['completed', 'cancelled'] },
          roomClosed: false,
        },
        take: 20,
      });
      for (const m of ended)
        try {
          await this.calls.request(m.roomName, '', 'DELETE');
          await this.prisma.meeting.updateMany({
            where: { id: m.id },
            data: { roomClosed: true },
          });
        } catch {
          this.logger.warn('Meeting room cleanup will retry');
        }
    }
    let completedCursor: string | undefined;
    while (!this.closing) {
      const completed = await this.prisma.meeting.findMany({
        where: {
          ...(completedCursor ? { id: { gt: completedCursor } } : {}),
          status: 'completed',
          transcriptSource: 'recording',
          publishedAt: null,
          recordings: {
            some: { status: 'ready' },
            every: { status: { in: ['ready', 'failed'] } },
          },
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: 200,
      });
      for (const m of completed) await this.queueTranscript(m.id);
      if (completed.length < 200) break;
      completedCursor = completed.at(-1)!.id;
    }
    const pending = await this.prisma.meeting.findMany({
      where: {
        analysisStatus: { in: ['queued', 'processing'] },
        OR: [{ processingUntil: null }, { processingUntil: { lt: now } }],
        publishedAt: null,
      },
      take: 5,
      orderBy: { updatedAt: 'asc' },
    });
    for (const m of pending) await this.analyze(m.id);
  }

  async recording(id: string) {
    const lease = new Date(Date.now() + 20 * 60_000);
    const claimed = await this.prisma.meetingRecording.updateMany({
      where: {
        id,
        OR: [
          { processingUntil: null },
          { processingUntil: { lt: new Date() } },
        ],
      },
      data: { processingUntil: lease },
    });
    if (!claimed.count) return;
    const row = await this.prisma.meetingRecording.findUniqueOrThrow({
      where: { id },
      include: { meeting: true },
    });
    try {
      const room = row.meeting.roomName;
      if (row.status === 'starting' && row.meeting.status !== 'live') {
        await this.prisma.meetingRecording.update({
          where: { id },
          data: {
            status: 'failed',
            error: 'Встреча закончилась до начала записи.',
          },
        });
        return;
      }
      let recordings = row.fileKey
        ? []
        : await this.calls.request<CallRecording[]>(room, '/recordings');
      if (row.status === 'starting') {
        const result = await this.calls.request<CallRecording>(
          room,
          '/recordings',
          'POST',
        );
        await this.prisma.meetingRecording.update({
          where: { id },
          data: { egressId: result.id },
        });
        await this.prisma.meetingRecording.updateMany({
          where: { id, status: 'starting' },
          data: { status: 'recording' },
        });
        recordings = [result];
      }
      if (row.status === 'stopping')
        recordings = await this.calls.request<CallRecording[]>(
          room,
          '/recordings/stop',
          'POST',
        );
      const egress = row.egressId
        ? recordings.find((e) => e.id === row.egressId)
        : recordings.at(-1);
      if (!egress && !row.fileKey && row.status !== 'starting')
        throw new Error('Recording was not found');
      if (egress && !row.egressId)
        await this.prisma.meetingRecording.update({
          where: { id },
          data: { egressId: egress.id },
        });
      if (egress && [4, 5, 6].includes(egress.status))
        throw new Error('Запись не завершилась. Проверьте Egress и хранилище.');
      const key =
        row.fileKey ||
        (egress?.status === 3 ? egress.files?.[0]?.filename : undefined);
      if (key) {
        await this.prisma.meetingRecording.update({
          where: { id },
          data: { fileKey: key, status: 'transcribing' },
        });
        const result = await this.calls.request<{
          uploadId?: string;
          taskId?: string;
          text?: string;
          failed?: boolean;
        }>(room, '/recordings/transcribe', 'POST', {
          key,
          uploadId: row.uploadId,
          taskId: row.speechTaskId,
        });
        if (result.failed || result.text === '')
          throw new Error('Сервис распознавания не вернул текст записи.');
        await this.prisma.meetingRecording.update({
          where: { id },
          data: {
            uploadId: result.uploadId || row.uploadId,
            speechTaskId: result.taskId || row.speechTaskId,
            ...(result.text !== undefined
              ? { transcript: result.text, status: 'ready' }
              : {}),
            error: null,
            attempts: 0,
          },
        });
        if (result.text !== undefined)
          await this.queueTranscript(row.meetingId);
      }
    } catch {
      const attempts = row.attempts + 1;
      await this.prisma.meetingRecording.updateMany({
        where: { id },
        data: {
          attempts,
          ...(attempts >= 6 ? { status: 'failed' } : {}),
          error:
            'Не удалось обработать запись. Проверьте настройки LiveKit, хранилища и сервиса распознавания.',
        },
      });
    } finally {
      await this.prisma.meetingRecording.updateMany({
        where: { id, processingUntil: lease },
        data: {
          processingUntil: null,
          nextAttemptAt: new Date(
            Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** row.attempts),
          ),
        },
      });
    }
  }

  private async queueTranscript(id: string) {
    const scope = await this.prisma.meeting.findUnique({
      where: { id },
      select: { workspaceId: true },
    });
    if (!scope) return;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'SELECT pg_advisory_xact_lock(hashtext($1))',
        'team:' + scope.workspaceId,
      );
      const m = await tx.meeting.findUniqueOrThrow({
        where: { id },
        include: { recordings: { orderBy: { createdAt: 'asc' } } },
      });
      if (
        m.publishedAt ||
        m.transcriptSource === 'manual' ||
        m.status !== 'completed' ||
        m.recordings.some((r) => !['ready', 'failed'].includes(r.status))
      )
        return;
      const text = m.recordings
        .filter((r) => r.transcript)
        .map((r) => r.transcript)
        .join('\n\n');
      if (!text || m.transcript === text) return;
      if (text.length > 250000) {
        await tx.meeting.update({
          where: { id },
          data: {
            analysisStatus: 'failed',
            analysisError:
              'Общий объём расшифровки превышает 250 000 символов. Сократите и загрузите её вручную.',
          },
        });
        return;
      }
      await tx.meeting.update({
        where: { id },
        data: {
          transcript: text,
          analysisStatus: 'queued',
          analysisRevision: { increment: 1 },
          analysisError: null,
        },
      });
    });
  }

  async analyze(id: string) {
    const now = new Date(),
      lease = new Date(Date.now() + 30 * 60_000);
    const claim = await this.prisma.meeting.updateMany({
      where: {
        id,
        publishedAt: null,
        analysisStatus: { in: ['queued', 'processing'] },
        OR: [{ processingUntil: null }, { processingUntil: { lt: now } }],
      },
      data: { analysisStatus: 'processing', processingUntil: lease },
    });
    if (!claim.count) return;
    const m = await this.prisma.meeting.findUniqueOrThrow({
      where: { id },
      include: { department: true, workspace: { select: { ownerId: true } } },
    });
    const where = {
      id,
      analysisRevision: m.analysisRevision,
      publishedAt: null,
      processingUntil: lease,
    };
    try {
      const active = await this.prisma.subscription.count({
        where: { userId: m.workspace.ownerId, activeUntil: { gt: new Date() } },
      });
      if (!active) {
        await this.prisma.meeting.updateMany({
          where,
          data: {
            analysisStatus: 'queued',
            processingUntil: new Date(Date.now() + 3600000),
          },
        });
        return;
      }
      const analyzePart = async (context: unknown) => {
        const nextLease = new Date(Date.now() + 30 * 60_000);
        const renewed = await this.prisma.meeting.updateMany({
          where,
          data: { processingUntil: nextLease },
        });
        if (!renewed.count) throw new Error('Analysis was replaced');
        where.processingUntil = nextLease;
        return this.ai.analyzeMeeting(context);
      };
      const employees = await this.prisma.user.findMany({
        where: {
          OR: [
            { id: m.workspace.ownerId },
            { departments: { some: { departmentId: m.departmentId } } },
          ],
        },
        select: { id: true, name: true },
      });
      const context = {
        meeting: {
          title: m.title,
          date: m.startedAt || m.startsAt,
          timeZone: 'Europe/Moscow',
          objective: m.objective,
          agenda: m.agenda,
          department: m.department.name,
          organizerId: m.organizerId,
        },
        employees,
      };
      const parts: MeetingAnalysis[] = [];
      for (let start = 0; start < m.transcript.length; start += 20000)
        parts.push(
          await analyzePart({
            ...context,
            transcript: m.transcript.slice(start, start + 20000),
            part: parts.length + 1,
          }),
        );
      if (!parts.length) throw new Error('Empty transcript');
      let result = parts[0];
      for (let i = 1; i < parts.length; i++)
        result = await analyzePart({
          ...context,
          combineChronologicalParts: [result, parts[i]],
        });
      const validIds = new Set(employees.map((p) => p.id));
      result.tasks = result.tasks.map((t) => ({
        ...t,
        assigneeIds: t.assigneeIds.filter((id) => validIds.has(id)),
      }));
      await this.prisma.meeting.updateMany({
        where,
        data: {
          analysis: result as unknown as Prisma.InputJsonValue,
          analysisStatus: 'draft',
          analysisError: null,
          processingUntil: null,
        },
      });
    } catch {
      await this.prisma.meeting.updateMany({
        where,
        data: {
          analysisStatus: 'failed',
          analysisError:
            'Не удалось составить протокол. Расшифровка сохранена; повторите обработку.',
          processingUntil: null,
        },
      });
    }
  }

  async onModuleDestroy() {
    this.closing = true;
    await this.worker?.close();
    await this.queue?.close();
    this.producer?.disconnect();
    this.consumer?.disconnect();
  }
}
