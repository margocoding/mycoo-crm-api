import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AiCooConversation, AiCooDocument, AiCooTurn, Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { GigachatService } from '../gigachat/gigachat.service.js';
import type { CooMessage } from '../gigachat/coo.types.js';
import { AiCooContextService, type AiCooContext } from './ai-coo-context.service.js';
import { AiCooMessageDto } from './ai-coo.dto.js';
import { COO_FILE_COUNT, type CooUpload, validateCooFile } from './ai-coo-files.js';

type DocumentLabel = { id: string; name: string };
const labels = (value: Prisma.JsonValue): DocumentLabel[] => Array.isArray(value)
  ? value.flatMap(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && typeof item.name === 'string' ? [{ id: item.id, name: item.name }] : []) : [];

export function cooHistory(turns: AiCooTurn[], documents: AiCooDocument[]): CooMessage[] {
  const selected: CooMessage[][] = [];
  let budget = 24_000;
  // The query is newest first; retain whole question/answer pairs within the budget.
  for (const turn of turns) {
    if (turn.status !== 'complete' || !turn.answer) continue;
    const length = turn.question.length + turn.answer.length;
    if (length > budget && selected.length) break;
    const shorten = (text: string, limit: number) => text.length > limit ? text.slice(0, limit - 38) + '\n[Предыдущее сообщение сокращено.]' : text;
    const question = shorten(turn.question, Math.min(8000, budget / 2));
    const answer = shorten(turn.answer, budget - question.length);
    budget -= question.length + answer.length;
    const oldIds = labels(turn.documents).map(doc => doc.id).sort();
    const currentIds = documents.map(doc => doc.id).sort();
    const sameDocuments = oldIds.length === currentIds.length && oldIds.every((id, index) => id === currentIds[index]);
    selected.push([
      { role: 'user', content: question },
      { role: 'assistant', content: answer,
        ...(sameDocuments && documents.length && turn.functionsStateId ? { functionsStateId: turn.functionsStateId } : {}) },
    ]);
  }
  return selected.reverse().flat();
}

@Injectable()
export class AiCooService {
  private readonly logger = new Logger(AiCooService.name);

  constructor(private readonly prisma: PrismaService, private readonly context: AiCooContextService,
    private readonly gigachat: GigachatService) {}

  private async conversation(userId: string, workspaceId: string, departmentId?: string) {
    const context = await this.context.build(userId, workspaceId, departmentId);
    const key = { userId, workspaceId, scopeKey: context.scopeKey };
    const conversation = await this.prisma.aiCooConversation.upsert({
      where: { workspaceId_userId_scopeKey: key }, create: key, update: {},
    });
    return { conversation, context };
  }

  private presentDocument(document: AiCooDocument) {
    return { id: document.id, name: document.name, size: document.size,
      mimeType: document.mimeType, createdAt: document.createdAt.toISOString() };
  }

  private async state(conversation: AiCooConversation, context: AiCooContext) {
    const [documents, turns] = await Promise.all([
      this.prisma.aiCooDocument.findMany({ where: { conversationId: conversation.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
      this.prisma.aiCooTurn.findMany({ where: { conversationId: conversation.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 25 }),
    ]);
    const messages = turns.reverse().flatMap(turn => {
      const status = turn.status === 'pending' && (!conversation.lockedUntil || conversation.lockedUntil <= new Date())
        ? 'failed' : turn.status;
      const user = { id: turn.id + ':user', role: 'user' as const, content: turn.question,
        createdAt: turn.createdAt.toISOString(), requestId: turn.requestId, status, documents: labels(turn.documents) };
      return turn.status === 'complete' && turn.answer ? [user, {
        id: turn.id + ':assistant', role: 'assistant' as const, content: turn.answer,
        createdAt: (turn.completedAt ?? turn.createdAt).toISOString(), status: 'complete',
      }] : [user];
    });
    return { conversation: { id: conversation.id }, scope: context.scope, scopes: context.scopes,
      context: context.summary, documents: documents.map(doc => this.presentDocument(doc)), messages };
  }

  async get(userId: string, workspaceId: string, departmentId?: string) {
    const data = await this.conversation(userId, workspaceId, departmentId);
    return this.state(data.conversation, data.context);
  }

  private async lock(conversationId: string) {
    const token = randomUUID();
    const result = await this.prisma.aiCooConversation.updateMany({
      where: { id: conversationId, OR: [{ lockedUntil: null }, { lockedUntil: { lte: new Date() } }] },
      data: { lockToken: token, lockedUntil: new Date(Date.now() + this.gigachat.totalTimeoutMs + 60_000) },
    });
    if (!result.count) throw new ConflictException('Предыдущий запрос ещё обрабатывается. Дождитесь ответа и повторите.');
    return token;
  }

  private async unlock(id: string, token: string) {
    await this.prisma.aiCooConversation.updateMany({ where: { id, lockToken: token }, data: { lockToken: null, lockedUntil: null } });
  }

  private async verifyScope(userId: string, workspaceId: string, departmentId: string | undefined, scopeKey: string) {
    const latest = await this.context.build(userId, workspaceId, departmentId);
    if (latest.scopeKey !== scopeKey) throw new ForbiddenException('Права доступа изменились. Обновите диалог.');
    return latest;
  }

  // Fence late upstream responses: a request whose lease expired cannot overwrite a newer turn.
  private async withLease<T>(id: string, token: string, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.prisma.$transaction(async tx => {
      const claimed = await tx.aiCooConversation.updateMany({ where: { id, lockToken: token, lockedUntil: { gt: new Date() } },
        data: { lockToken: token } });
      if (!claimed.count) throw new ConflictException('Запрос устарел. Обновите диалог и повторите.');
      return action(tx);
    });
  }

  private async consumeRequest(tx: Prisma.TransactionClient, id: string) {
    const conversation = await tx.aiCooConversation.findUniqueOrThrow({ where: { id } });
    const now = new Date();
    const currentWindow = conversation.requestWindowAt && now.getTime() - conversation.requestWindowAt.getTime() < 300_000;
    if (currentWindow && conversation.requestCount >= 30)
      throw new HttpException('Слишком много запросов. Попробуйте через несколько минут.', 429);
    await tx.aiCooConversation.update({ where: { id }, data: {
      requestWindowAt: currentWindow ? conversation.requestWindowAt : now,
      requestCount: currentWindow ? conversation.requestCount + 1 : 1,
    } });
  }

  async send(userId: string, workspaceId: string, dto: AiCooMessageDto) {
    const { conversation, context } = await this.conversation(userId, workspaceId, dto.departmentId);
    const id = conversation.id;
    const unique = { conversationId: id, requestId: dto.requestId };
    const existing = await this.prisma.aiCooTurn.findUnique({ where: { conversationId_requestId: unique } });
    const text = dto.text.trim() || 'Проанализируй загруженные документы.';
    if (existing && existing.question !== text) throw new BadRequestException('Для другого сообщения нужен новый идентификатор запроса.');
    if (existing?.status === 'complete') return this.state(conversation, context);
    const token = await this.lock(id);
    let turnId: string | undefined;
    try {
      // The first response may have finished between the initial read and acquiring the lease.
      const lockedExisting = await this.prisma.aiCooTurn.findUnique({ where: { conversationId_requestId: unique } });
      if (lockedExisting && lockedExisting.question !== text) throw new BadRequestException('Для другого сообщения нужен новый идентификатор запроса.');
      if (lockedExisting?.status === 'complete') return this.state(conversation, context);
      const [documents, history] = await Promise.all([
        this.prisma.aiCooDocument.findMany({ where: { conversationId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }),
        this.prisma.aiCooTurn.findMany({ where: { conversationId: id, status: 'complete' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 12 }),
      ]);
      if (!dto.text.trim() && !documents.length) throw new BadRequestException('Введите сообщение или загрузите документ.');
      const documentLabels = documents.map(doc => ({ id: doc.id, name: doc.name }));
      const turn = await this.withLease(id, token, async tx => {
        await this.consumeRequest(tx, id);
        return tx.aiCooTurn.upsert({ where: { conversationId_requestId: unique },
          create: { ...unique, question: text, documents: documentLabels },
          update: { status: 'pending', answer: null, completedAt: null, functionsStateId: null, documents: documentLabels },
        });
      });
      turnId = turn.id;
      const response = await this.gigachat.chatCoo({ clientId: id,
        context: { ...context.prompt, documents: documentLabels.map(doc => ({ name: doc.name })) },
        messages: [...cooHistory(history, documents), { role: 'user', content: text,
          ...(documents.length ? { attachments: documents.map(doc => doc.providerFileId) } : {}) }],
      });
      await this.verifyScope(userId, workspaceId, dto.departmentId, context.scopeKey);
      await this.withLease(id, token, tx => tx.aiCooTurn.update({ where: { id: turn.id },
        data: { status: 'complete', answer: response.content, functionsStateId: response.functionsStateId ?? null, completedAt: new Date() } }));
    } catch (error) {
      if (turnId) {
        try { await this.withLease(id, token, tx => tx.aiCooTurn.updateMany({ where: { id: turnId, status: 'pending' }, data: { status: 'failed' } })); }
        catch { /* An expired lease belongs to the newer request; never change its state. */ }
      }
      if (error instanceof HttpException) throw error;
      this.logger.error('AI COO message could not be saved or completed.');
      throw new ServiceUnavailableException('Не удалось получить ответ. Сообщение сохранено, попробуйте повторить.');
    } finally { await this.unlock(id, token); }
    return this.get(userId, workspaceId, dto.departmentId);
  }

  async upload(userId: string, workspaceId: string, departmentId: string | undefined, file?: CooUpload) {
    const { conversation, context } = await this.conversation(userId, workspaceId, departmentId);
    const valid = validateCooFile(file);
    const token = await this.lock(conversation.id);
    let uploadedId: string | undefined;
    let saved = false;
    try {
      const count = await this.prisma.aiCooDocument.count({ where: { conversationId: conversation.id } });
      if (count >= COO_FILE_COUNT) throw new BadRequestException('В одном диалоге можно использовать не больше 5 документов. Удалите ненужные.');
      const uploaded = await this.gigachat.uploadCooDocument({ ...valid, clientId: conversation.id });
      uploadedId = uploaded.id;
      await this.verifyScope(userId, workspaceId, departmentId, context.scopeKey);
      const document = await this.withLease(conversation.id, token, tx => tx.aiCooDocument.create({ data: {
        conversationId: conversation.id, providerFileId: uploaded.id, name: valid.name, size: valid.size, mimeType: valid.mimeType,
      } }));
      saved = true;
      return this.presentDocument(document);
    } finally {
      if (uploadedId && !saved) {
        try { await this.gigachat.deleteCooDocument(uploadedId, conversation.id); }
        catch { this.logger.warn('AI COO failed upload cleanup could not be completed.'); }
      }
      await this.unlock(conversation.id, token);
    }
  }

  async removeDocument(userId: string, workspaceId: string, departmentId: string | undefined, documentId: string) {
    const { conversation, context } = await this.conversation(userId, workspaceId, departmentId);
    const token = await this.lock(conversation.id);
    try {
      const document = await this.prisma.aiCooDocument.findFirst({ where: { id: documentId, conversationId: conversation.id } });
      if (!document) throw new NotFoundException('Документ не найден.');
      await this.gigachat.deleteCooDocument(document.providerFileId, conversation.id);
      await this.verifyScope(userId, workspaceId, departmentId, context.scopeKey);
      await this.withLease(conversation.id, token, tx => tx.aiCooDocument.delete({ where: { id: document.id } }));
      return { deleted: true };
    } finally { await this.unlock(conversation.id, token); }
  }
}
