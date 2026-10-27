import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiCooDocument, AiCooTurn } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { GigachatService } from '../gigachat/gigachat.service.js';
import type { AiCooContext, AiCooContextService } from './ai-coo-context.service.js';
import { COO_FILE_SIZE, validateCooFile } from './ai-coo-files.js';
import { AiCooService, cooHistory } from './ai-coo.service.js';

const now = new Date('2026-10-27T08:00:00Z');
const requestId = '6305dcb3-cba7-4df2-a114-336b31d371ab';
const pdf = (originalname = 'report.pdf') => ({ originalname, buffer: Buffer.from('%PDF-1.7\nfixture'), size: 16 });
const clone = <T>(value: T): T => structuredClone(value);

function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === 'OR') return condition.some((item: any) => matches(row, item));
    const value = row[key];
    if (condition === null || typeof condition !== 'object') return value === condition;
    if ('gt' in condition) return value !== null && value > condition.gt;
    if ('gte' in condition) return value !== null && value >= condition.gte;
    if ('lte' in condition) return value !== null && value <= condition.lte;
    throw new Error(`Unsupported fixture condition ${key}`);
  });
}

function fixture() {
  const conversations: any[] = [], turns: any[] = [], documents: any[] = [];
  let sequence = 0;
  const access = { scopeKey: 'department:a' };
  const context = { build: vi.fn(async () => ({
    scopeKey: access.scopeKey, scope: { departmentId: 'a', name: 'Отдел', personal: access.scopeKey.startsWith('personal:') },
    scopes: [{ id: 'a', name: 'Отдел' }], summary: { marker: 'current context' }, prompt: { marker: 'current context' },
  } as unknown as AiCooContext)) };
  const provider = {
    totalTimeoutMs: 120_000,
    chatCoo: vi.fn(async () => ({ content: 'Ответ по текущим задачам', functionsStateId: 'function-state' })),
    uploadCooDocument: vi.fn(async () => ({ id: `upstream-${++sequence}`, bytes: 16, name: 'report.pdf' })),
    deleteCooDocument: vi.fn(async () => undefined),
  };
  const byNewest = (rows: any[], take = Infinity) => [...rows]
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id)).slice(0, take).map(clone);
  const prisma: any = {
    aiCooConversation: {
      upsert: vi.fn(async ({ where, create }: any) => {
        let row = conversations.find(item => matches(item, where.workspaceId_userId_scopeKey));
        if (!row) { row = { id: `conversation-${++sequence}`, ...create, createdAt: new Date(),
          lockToken: null, lockedUntil: null, requestWindowAt: null, requestCount: 0 }; conversations.push(row); }
        return clone(row);
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const row = conversations.find(item => matches(item, where));
        if (!row) throw new Error('Missing fixture conversation');
        return clone(row);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = conversations.find(item => matches(item, where));
        if (!row) throw new Error('Missing fixture conversation');
        Object.assign(row, data); return clone(row);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const found = conversations.filter(item => matches(item, where));
        found.forEach(item => Object.assign(item, data));
        return { count: found.length };
      }),
    },
    aiCooTurn: {
      findUnique: vi.fn(async ({ where }: any) => clone(turns.find(item => matches(item, where.conversationId_requestId)) ?? null)),
      findMany: vi.fn(async ({ where, take }: any) => byNewest(turns.filter(item => matches(item, where)), take)),
      upsert: vi.fn(async ({ where, create, update }: any) => {
        let row = turns.find(item => matches(item, where.conversationId_requestId));
        if (row) Object.assign(row, update);
        else { row = { id: `turn-${++sequence}`, status: 'pending', answer: null, functionsStateId: null,
          createdAt: new Date(), completedAt: null, ...create }; turns.push(row); }
        return clone(row);
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = turns.find(item => matches(item, where));
        if (!row) throw new Error('Missing fixture turn');
        Object.assign(row, data); return clone(row);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const found = turns.filter(item => matches(item, where));
        found.forEach(item => Object.assign(item, data)); return { count: found.length };
      }),
    },
    aiCooDocument: {
      findMany: vi.fn(async ({ where }: any) => documents.filter(item => matches(item, where)).map(clone)),
      findFirst: vi.fn(async ({ where }: any) => clone(documents.find(item => matches(item, where)) ?? null)),
      count: vi.fn(async ({ where }: any) => documents.filter(item => matches(item, where)).length),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `document-${++sequence}`, createdAt: new Date(), ...data };
        documents.push(row); return clone(row);
      }),
      delete: vi.fn(async ({ where }: any) => {
        const index = documents.findIndex(item => matches(item, where));
        if (index < 0) throw new Error('Missing fixture document');
        return documents.splice(index, 1)[0];
      }),
    },
    $transaction: vi.fn(async (action: (db: any) => unknown) => action(prisma)),
  };
  const service = new AiCooService(prisma as PrismaService, context as unknown as AiCooContextService,
    provider as unknown as GigachatService);
  return { service, prisma, provider, context, access, conversations, turns, documents };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe('AI COO persisted conversation', () => {
  it('isolates messages and documents by user, company and current permission scope', async () => {
    const f = fixture();
    const bobDocument = await f.service.upload('bob', 'company', 'a', pdf());
    const bob = await f.service.send('bob', 'company', { departmentId: 'a', text: 'Private question', requestId });
    expect(bob.messages).toHaveLength(2);
    expect(bob.documents[0].id).toBe(bobDocument.id);
    expect(JSON.stringify(bob)).not.toContain('upstream-');
    const alice = await f.service.get('alice', 'company', 'a');
    expect(alice.messages).toEqual([]);
    expect(alice.documents).toEqual([]);
    expect((await f.service.get('bob', 'other-company', 'a')).messages).toEqual([]);
    f.access.scopeKey = 'personal:a';
    expect((await f.service.get('bob', 'company', 'a')).messages).toEqual([]);
    expect(new Set(f.conversations.map(row => row.id)).size).toBe(4);
  });

  it('returns a completed idempotent request without another model call and rejects UUID reuse for another message', async () => {
    const f = fixture();
    const dto = { text: 'Что просрочено?', requestId };
    const first = await f.service.send('alice', 'company', dto);
    const second = await f.service.send('alice', 'company', dto);
    expect(second.messages).toEqual(first.messages);
    expect(f.provider.chatCoo).toHaveBeenCalledTimes(1);
    expect(f.turns).toHaveLength(1);
    await expect(f.service.send('alice', 'company', { ...dto, text: 'Другой запрос' })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.provider.chatCoo).toHaveBeenCalledTimes(1);
  });

  it('retries a failed UUID in place and stores just one successful question-answer pair', async () => {
    const f = fixture();
    f.provider.chatCoo.mockRejectedValueOnce(new ServiceUnavailableException('Provider unavailable'));
    const dto = { text: 'Что сделать сначала?', requestId };
    await expect(f.service.send('alice', 'company', dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.turns[0].status).toBe('failed');
    expect(f.conversations[0].lockToken).toBeNull();
    const firstTurnId = f.turns[0].id;
    const recovered = await f.service.send('alice', 'company', dto);
    expect(recovered.messages).toHaveLength(2);
    expect(f.turns).toHaveLength(1);
    expect(f.turns[0]).toMatchObject({ id: firstTurnId, status: 'complete' });
    expect(f.provider.chatCoo).toHaveBeenCalledTimes(2);
  });

  it('rechecks idempotence after the lease when the initial read raced with another completed response', async () => {
    const f = fixture();
    const dto = { text: 'Что просрочено?', requestId };
    await f.service.send('alice', 'company', dto);
    // Simulate a stale pre-lock read; the next read observes the committed response.
    f.prisma.aiCooTurn.findUnique.mockResolvedValueOnce(null);
    expect((await f.service.send('alice', 'company', dto)).messages).toHaveLength(2);
    expect(f.provider.chatCoo).toHaveBeenCalledTimes(1);
    expect(f.conversations[0].requestCount).toBe(1);
    f.prisma.aiCooTurn.findUnique.mockResolvedValueOnce(null);
    await expect(f.service.send('alice', 'company', { ...dto, text: 'Другой запрос' })).rejects.toBeInstanceOf(BadRequestException);
    expect(f.provider.chatCoo).toHaveBeenCalledTimes(1);
    expect(f.turns[0].question).toBe(dto.text);
  });

  it('counts failed retries in the persisted rate window and permits requests again after it expires', async () => {
    const f = fixture();
    f.provider.chatCoo.mockRejectedValue(new ServiceUnavailableException());
    const dto = { text: 'Повтор', requestId };
    for (let index = 0; index < 30; index++) {
      await expect(f.service.send('alice', 'company', dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    }
    await expect(f.service.send('alice', 'company', dto)).rejects.toMatchObject({ status: 429 });
    expect(f.provider.chatCoo).toHaveBeenCalledTimes(30);
    expect(f.turns).toHaveLength(1);
    expect(f.conversations[0].requestCount).toBe(30);
    expect(f.conversations[0].lockToken).toBeNull();
    vi.setSystemTime(new Date(now.getTime() + 300_001));
    await expect(f.service.send('alice', 'company', dto)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(f.provider.chatCoo).toHaveBeenCalledTimes(31);
    expect(f.conversations[0].requestCount).toBe(1);
  });

  it('refuses a second active request without calling the model or adding a pending turn', async () => {
    const f = fixture();
    await f.service.get('alice', 'company');
    Object.assign(f.conversations[0], { lockToken: 'another-request', lockedUntil: new Date(now.getTime() + 60_000) });
    await expect(f.service.send('alice', 'company', { text: 'Вопрос', requestId })).rejects.toBeInstanceOf(ConflictException);
    expect(f.turns).toEqual([]);
    expect(f.provider.chatCoo).not.toHaveBeenCalled();
    expect(f.conversations[0].lockToken).toBe('another-request');
  });

  it('does not save a privileged answer after the user is demoted during inference', async () => {
    const f = fixture();
    f.provider.chatCoo.mockImplementationOnce(async () => {
      f.access.scopeKey = 'personal:a';
      return { content: 'Management-only response', functionsStateId: 'sensitive-state' };
    });
    await expect(f.service.send('alice', 'company', { departmentId: 'a', text: 'Обзор отдела', requestId }))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(f.turns[0]).toMatchObject({ status: 'failed', answer: null, functionsStateId: null });
    expect(f.conversations[0].lockToken).toBeNull();
    expect((await f.service.get('alice', 'company', 'a')).messages).toEqual([]);
  });

  it('fences a late provider response after its lease has expired', async () => {
    const f = fixture();
    f.provider.chatCoo.mockImplementationOnce(async () => {
      vi.setSystemTime(new Date(now.getTime() + 180_001));
      return { content: 'Late answer', functionsStateId: 'late-state' };
    });
    await expect(f.service.send('alice', 'company', { text: 'Вопрос', requestId })).rejects.toBeInstanceOf(ConflictException);
    expect(f.turns[0].answer).toBeNull();
    const state = await f.service.get('alice', 'company');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].status).toBe('failed');
  });
});

describe('AI COO private documents', () => {
  it('rejects an unsupported extension, a false signature and oversized contents before a provider upload', async () => {
    const f = fixture();
    for (const file of [pdf('script.exe'), { ...pdf(), buffer: Buffer.from('Not a PDF') },
      { ...pdf(), buffer: Buffer.alloc(COO_FILE_SIZE + 1) }]) {
      await expect(f.service.upload('alice', 'company', 'a', file)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(f.provider.uploadCooDocument).not.toHaveBeenCalled();
    expect(f.documents).toEqual([]);
  });

  it('uses actual byte count and strips paths/control characters from filenames', () => {
    const file = { ...pdf('C:\\secret\\report\u0000.pdf'), size: 1 };
    const valid = validateCooFile(file);
    expect(valid.name).toBe('report.pdf');
    expect(valid.size).toBe(file.buffer.length);
    expect(valid.mimeType).toBe('application/pdf');
  });

  it('enforces the document limit under the conversation lock', async () => {
    const f = fixture();
    for (let index = 0; index < 5; index++) await f.service.upload('alice', 'company', 'a', pdf(`${index}.pdf`));
    await expect(f.service.upload('alice', 'company', 'a', pdf('extra.pdf'))).rejects.toBeInstanceOf(BadRequestException);
    expect(f.provider.uploadCooDocument).toHaveBeenCalledTimes(5);
    expect(f.documents).toHaveLength(5);
    expect(f.conversations[0].lockToken).toBeNull();
  });

  it('cannot delete a document belonging to another user even when its public ID is known', async () => {
    const f = fixture();
    const document = await f.service.upload('bob', 'company', 'a', pdf());
    const providerFileId = f.documents[0].providerFileId;
    await expect(f.service.removeDocument('alice', 'company', 'a', document.id)).rejects.toMatchObject({ status: 404 });
    expect(f.provider.deleteCooDocument).not.toHaveBeenCalled();
    expect(f.documents).toHaveLength(1);
    expect(await f.service.removeDocument('bob', 'company', 'a', document.id)).toEqual({ deleted: true });
    expect(f.provider.deleteCooDocument).toHaveBeenCalledWith(providerFileId, f.conversations[0].id);
    expect(f.documents).toEqual([]);
  });

  it('deletes the provider upload when persisting the private document fails', async () => {
    const f = fixture();
    f.prisma.aiCooDocument.create.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.service.upload('alice', 'company', 'a', pdf())).rejects.toThrow('database unavailable');
    expect(f.provider.deleteCooDocument).toHaveBeenCalledTimes(1);
    expect(f.provider.deleteCooDocument).toHaveBeenCalledWith('upstream-2', f.conversations[0].id);
    expect(f.documents).toEqual([]);
    expect(f.conversations[0].lockToken).toBeNull();
  });

  it('cleans up the upstream document if role access changes during upload', async () => {
    const f = fixture();
    f.provider.uploadCooDocument.mockImplementationOnce(async () => {
      f.access.scopeKey = 'personal:a';
      return { id: 'upstream-revoked', bytes: 16, name: 'report.pdf' };
    });
    await expect(f.service.upload('alice', 'company', 'a', pdf())).rejects.toBeInstanceOf(ForbiddenException);
    expect(f.provider.deleteCooDocument).toHaveBeenCalledWith('upstream-revoked', f.conversations[0].id);
    expect(f.prisma.aiCooDocument.create).not.toHaveBeenCalled();
    expect(f.conversations[0].lockToken).toBeNull();
  });
});

describe('AI COO model history', () => {
  const turn = (id: string, overrides: Record<string, any> = {}): AiCooTurn => ({ id, question: `Question ${id}`, answer: `Answer ${id}`,
    status: 'complete', documents: [{ id: 'doc', name: 'report.pdf' }], functionsStateId: 'file-state',
    createdAt: now, completedAt: now, requestId, conversationId: 'conversation', ...overrides });
  it('keeps completed pairs in order and stops replaying file state after the attachment set changes', () => {
    const turns = [turn('3'), turn('2', { status: 'failed', answer: null }), turn('1')];
    const withFile = cooHistory(turns, [{ id: 'doc' } as AiCooDocument]);
    expect(withFile.map(message => message.content)).toEqual(['Question 1', 'Answer 1', 'Question 3', 'Answer 3']);
    expect(withFile.filter(message => message.role === 'assistant').every(message => message.functionsStateId === 'file-state')).toBe(true);
    expect(cooHistory(turns, []).some(message => message.functionsStateId)).toBe(false);
    expect(cooHistory(turns, [{ id: 'different-doc' } as AiCooDocument]).some(message => message.functionsStateId)).toBe(false);
  });

  it('preserves complete recent pairs within the history budget', () => {
    const history = cooHistory([turn('new'), turn('old', { answer: 'x'.repeat(24_000) })], []);
    expect(history.map(message => message.content)).toEqual(['Question new', 'Answer new']);
  });

  it('keeps the latest long pair with explicit truncation instead of dropping all conversation context', () => {
    const history = cooHistory([turn('long', { question: 'q'.repeat(8000), answer: 'a'.repeat(20_000) }), turn('old')], []);
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('q'.repeat(8000));
    expect(history[1].content).toContain('[Предыдущее сообщение сокращено.]');
    expect(history.reduce((sum, message) => sum + message.content.length, 0)).toBeLessThanOrEqual(24_000);
  });
});
