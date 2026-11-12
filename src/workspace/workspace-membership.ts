import { ConflictException } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

// All entry/exit paths use the same per-user lock, including concurrent invitations.
export async function lockMembership(tx: Prisma.TransactionClient, userId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
}

export async function assertSingleWorkspace(tx: Prisma.TransactionClient, userId: string, exceptId?: string) {
  const current = await tx.workspace.findFirst({ where: {
    deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}),
    OR: [{ ownerId: userId }, { members: { some: { userId } } }],
  }, orderBy: { createdAt: 'asc' }, select: { id: true, company: true, ownerId: true } });
  if (current) throw new ConflictException({ code: 'WORKSPACE_MEMBERSHIP_CONFLICT',
    message: current.ownerId === userId
      ? 'Сначала удалите свою компанию, чтобы присоединиться к другой.'
      : 'Сначала выйдите из текущей компании.',
    workspace: { id: current.id, name: current.company || 'Моя компания', isOwner: current.ownerId === userId },
  });
}
