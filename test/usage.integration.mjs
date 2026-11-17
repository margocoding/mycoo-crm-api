import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../dist/prisma/prisma.service.js';
import { UsageService } from '../dist/src/usage/usage.service.js';
import { usageMonth, zeroUsage, RUB } from '../dist/src/usage/usage.policy.js';

const connection = process.env.USAGE_TEST_DATABASE_URL;
if (!connection) throw new Error('Set USAGE_TEST_DATABASE_URL to an isolated migrated PostgreSQL test database.');
const url = new URL(connection);
if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('test'))
  throw new Error('This test only runs against a local database whose name contains test.');
process.env.DATABASE_URL = connection;
const db = new PrismaService();
const usage = new UsageService(db, new ConfigService({}));
const userIds = [], owners = [];
const amount = (rub = 0, extra = {}) => ({ ...zeroUsage(), costMicros: rub * RUB, ...extra });
const limited = resource => error => error.getStatus?.() === 403 && error.getResponse().resource === resource;
const tests = [];
async function person(name) {
  const user = await db.user.create({ data: { email: `${randomUUID()}@usage-test.invalid`, name, passwordHash: 'not-a-login', trialStartedAt: new Date() } });
  userIds.push(user.id); return user;
}
async function fixture(plan = 'TRIAL') {
  const owner = await person('Owner'); owners.push(owner.id);
  const workspace = await db.workspace.create({ data: { ownerId: owner.id, company: 'Usage test', ownerEmail: owner.email, ownerName: owner.name,
    members: { create: { userId: owner.id, role: 'OWNER' } }, departments: { create: [{ name: 'A' }, { name: 'B' }] } }, include: { departments: true } });
  const subscription = await db.subscription.create({ data: { userId: owner.id, kind: plan === 'TRIAL' ? 'TRIAL' : 'PAID',
    plan: plan === 'TRIAL' ? null : plan, period: 'YEAR', activeUntil: new Date(Date.now() + 366 * 86400000), usageAnchorAt: new Date(Date.now() - 75 * 86400000) } });
  const scope = { workspaceId: workspace.id, source: 'test', actorId: owner.id };
  const charge = async value => { const entry = await usage.reserve(scope, value); await usage.settle(entry.id, value); return entry; };
  return { owner, workspace, subscription, scope, charge };
}
async function test(name, run) { await run(); tests.push(name); console.log('PASS ' + name); }

try {
  await test('concurrent reservations cannot overspend; settlement is idempotent', async () => {
    const f = await fixture();
    const result = await Promise.allSettled([usage.reserve(f.scope, amount(90)), usage.reserve(f.scope, amount(90))]);
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(limited('aiBudget')(result.find(r => r.status === 'rejected').reason));
    const entry = result.find(r => r.status === 'fulfilled').value;
    await usage.settle(entry.id, amount(30));
    await usage.settle(entry.id, amount(140));
    const second = await usage.reserve(f.scope, amount(120));
    await usage.settle(second.id, amount(120));
    await assert.rejects(usage.reserve(f.scope, amount(1)), limited('aiBudget'));
    assert.equal((await usage.summary(f.owner.id, f.workspace.id)).used.costRub, 150);
  });
  await test('uncertain provider responses retain capacity; rejected requests release it', async () => {
    const f = await fixture();
    const entry = await usage.reserve(f.scope, amount(140));
    await usage.settle(entry.id, null, 'UNKNOWN');
    await assert.rejects(usage.reserve(f.scope, amount(11)), limited('aiBudget'));
    await usage.settle(entry.id, null, 'RELEASED');
    assert.equal((await usage.summary(f.owner.id, f.workspace.id)).reserved.costRub, 0);
    await usage.reserve(f.scope, amount(150));
  });
  await test('trial input and output ceilings are enforced independently', async () => {
    for (const [resource, max] of [['inputTokens', 500000], ['outputTokens', 200000]]) {
      const f = await fixture(); await f.charge(amount(0, { [resource]: max }));
      await assert.rejects(usage.reserve(f.scope, amount(0, { [resource]: 1 })), limited(resource));
    }
  });
  await test('speech consumes both shared money and the separate hours ceiling', async () => {
    const f = await fixture(); await f.charge(amount(139));
    await assert.rejects(usage.reserve(f.scope, usage.speechAmount(1800, 'yandex')), limited('aiBudget'));
    const other = await fixture(); await other.charge(usage.speechAmount(10800, 'yandex'));
    await assert.rejects(usage.reserve(other.scope, usage.speechAmount(1, 'yandex')), limited('audioSeconds'));
    assert.equal((await usage.summary(other.owner.id, other.workspace.id)).used.costRub, 109.08);
  });
  await test('annual subscriptions get monthly windows; an upgrade preserves this month consumption', async () => {
    const f = await fixture('START');
    const current = usageMonth(f.subscription.usageAnchorAt);
    const old = await db.usageWindow.create({ data: { ownerId: f.owner.id, key: f.owner.id + ':old', startAt: new Date(current.start.getTime() - 86400000), endAt: current.start } });
    await db.usageEntry.create({ data: { operationKey: randomUUID(), windowId: old.id, ownerId: f.owner.id, workspaceId: f.workspace.id,
      source: 'test', status: 'CONFIRMED', costMicros: BigInt(1000 * RUB) } });
    await f.charge(amount(100));
    const before = await usage.summary(f.owner.id, f.workspace.id);
    assert.equal(before.used.costRub, 100); assert.equal(before.periodEnd, current.end.toISOString());
    await db.subscription.update({ where: { id: f.subscription.id }, data: { plan: 'MISSION' } });
    const after = await usage.summary(f.owner.id, f.workspace.id);
    assert.equal(after.used.costRub, 100); assert.equal(after.periodStart, before.periodStart); assert.equal(after.limits.budgetRub, 2500);
    await db.subscription.update({ where: { id: f.subscription.id }, data: { activeUntil: new Date(0) } });
    await assert.rejects(usage.reserve(f.scope, amount(1)), e => e.getStatus?.() === 402);
  });
  await test('80/90/100 alerts reach owner and admin once per threshold', async () => {
    const f = await fixture(); const admin = await person('Admin');
    await db.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: admin.id, role: 'TEAM_MEMBER' } });
    await db.departmentMember.create({ data: { departmentId: f.workspace.departments[0].id, userId: admin.id, role: 'ADMIN' } });
    for (const rub of [120, 15, 15]) {
      const entry = await f.charge(amount(rub)); await usage.settle(entry.id, amount(rub));
    }
    const notes = await db.notification.findMany({ where: { workspaceId: f.workspace.id, kind: 'AI_BUDGET' } });
    assert.equal(notes.length, 6);
    assert.deepEqual(new Set(notes.map(n => n.recipientId)), new Set([f.owner.id, admin.id]));
    assert.equal(notes.filter(n => n.message.includes('80%')).length, 2);
    assert.equal(notes.filter(n => n.message.includes('90%')).length, 2);
    assert.equal(notes.filter(n => n.message.includes('исчерпан')).length, 2);
  });
  await test('pending invitations share seat capacity; duplicate department invitations do not consume twice', async () => {
    const f = await fixture();
    for (let i = 0; i < 4; i++) await db.teamInvitation.create({ data: { departmentId: f.workspace.departments[0].id,
      email: `seat-${i}@example.test`, invitedById: f.owner.id, role: 'WORKER', tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 86400000) } });
    await db.$transaction(tx => usage.assertSeat(tx, f.workspace.id, 'SEAT-0@example.test'));
    await assert.rejects(db.$transaction(tx => usage.assertSeat(tx, f.workspace.id, 'new@example.test')), limited('users'));
  });
  await test('unfinished tasks are capped atomically and completion frees a place', async () => {
    const f = await fixture();
    await db.task.createMany({ data: Array.from({ length: 299 }, () => ({ workspaceId: f.workspace.id, title: 'Quota fixture', startDate: new Date(), dueDate: new Date() })) });
    const create = () => db.$transaction(async tx => { await usage.assertTasks(tx, f.workspace.id); return tx.task.create({ data: {
      workspaceId: f.workspace.id, title: 'Last place', startDate: new Date(), dueDate: new Date() } }); });
    const results = await Promise.allSettled([create(), create()]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(limited('tasks')(results.find(r => r.status === 'rejected').reason));
    await db.task.update({ where: { id: results.find(r => r.status === 'fulfilled').value.id }, data: { status: 'done' } });
    await create();
  });
  await test('storage reservations persist across months and release atomically with a saved document', async () => {
    const f = await fixture('START');
    const key = randomUUID();
    await db.$transaction(tx => usage.reserveStorage(tx, f.workspace.id, 4900000000, key));
    await assert.rejects(db.$transaction(tx => usage.reserveStorage(tx, f.workspace.id, 200000000, randomUUID())), limited('storageBytes'));
    await db.subscription.update({ where: { id: f.subscription.id }, data: { usageAnchorAt: new Date() } });
    await assert.rejects(db.$transaction(tx => usage.reserveStorage(tx, f.workspace.id, 200000000, randomUUID())), limited('storageBytes'));
    await db.$transaction(async tx => {
      await usage.lockStorage(tx, f.workspace.id);
      const conversation = await tx.aiCooConversation.create({ data: { workspaceId: f.workspace.id, userId: f.owner.id, scopeKey: 'company' } });
      await tx.aiCooDocument.create({ data: { conversationId: conversation.id, providerFileId: 'fixture-file', name: 'fixture.txt', size: 5000, mimeType: 'text/plain' } });
      await usage.releaseStorage(tx, key);
    });
    const summary = await usage.summary(f.owner.id, f.workspace.id);
    assert.equal(summary.used.storageBytes, 5000); assert.equal(summary.reserved.storageBytes, 0);
  });
  await test('ranking isolates departments even for a shared employee; a worker sees only their own usage', async () => {
    const f = await fixture(); const admin = await person('Lead'), worker = await person('Employee');
    for (const u of [admin, worker]) await db.workspaceMember.create({ data: { workspaceId: f.workspace.id, userId: u.id, role: 'TEAM_MEMBER' } });
    const [a, b] = f.workspace.departments;
    await db.departmentMember.createMany({ data: [
      { userId: admin.id, departmentId: a.id, role: 'CHIEF' },
      { userId: worker.id, departmentId: a.id, role: 'WORKER' }, { userId: worker.id, departmentId: b.id, role: 'WORKER' },
    ] });
    for (const [departmentId, inputTokens] of [[a.id, 100], [b.id, 900]]) {
      const value = amount(1, { inputTokens });
      const entry = await usage.reserve({ ...f.scope, departmentId, actorId: worker.id }, value); await usage.settle(entry.id, value);
    }
    await f.charge(amount(1, { inputTokens: 10 }));
    const led = await usage.summary(admin.id, f.workspace.id);
    assert.equal(led.topEmployees.length, 1); assert.equal(led.topEmployees[0].totalTokens, 100);
    const personal = await usage.summary(worker.id, f.workspace.id, a.id);
    assert.equal(personal.rankingScope, 'personal'); assert.equal(personal.topEmployees[0].totalTokens, 100);
    await assert.rejects(usage.summary(admin.id, f.workspace.id, b.id), e => e.getStatus?.() === 403);
    assert.equal((await usage.summary(f.owner.id, f.workspace.id)).topEmployees[0].totalTokens, 1000);
    const outsider = await person('Outsider');
    await assert.rejects(usage.summary(outsider.id, f.workspace.id), e => e.getStatus?.() === 404);
  });
  console.log(`Usage integration: ${tests.length} scenarios passed.`);
} finally {
  // Only rows created by this run, in the explicitly guarded local test database.
  await db.usageEntry.deleteMany({ where: { ownerId: { in: owners } } });
  await db.usageWindow.deleteMany({ where: { ownerId: { in: owners } } });
  await db.workspaceMember.deleteMany({ where: { workspace: { ownerId: { in: owners } } } });
  await db.workspace.deleteMany({ where: { ownerId: { in: owners } } });
  await db.subscription.deleteMany({ where: { userId: { in: owners } } });
  await db.user.deleteMany({ where: { id: { in: userIds } } });
  await db.$disconnect();
}
