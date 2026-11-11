// Isolated PostgreSQL/Redis integration; no external mail, OAuth or AI calls.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

const database = new URL(process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:5548/mycoo_nov11_test');
const redis = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6390/3');
assert(['127.0.0.1', 'localhost'].includes(database.hostname) && /test/.test(database.pathname), 'Local test database only');
assert(['127.0.0.1', 'localhost'].includes(redis.hostname), 'Local test Redis only');
Object.assign(process.env, { DATABASE_URL: database.href, REDIS_URL: redis.href, NODE_ENV: 'development',
  JWT_SECRET: randomBytes(32).toString('hex'), BCRYPT_SALT_ROUNDS: '4', SMTP_HOST: '',
  GIGACHAT_CREDENTIALS: '', YANDEX_ID_CLIENT_ID: 'integration-app',
  YANDEX_ID_REDIRECT_URI: 'https://api.example.test/api/auth/oauth/yandex/callback', APP_URL: 'http://127.0.0.1',
});
const [{ WorkspaceModule }, { TeamModule }, { BillingModule }, { PrismaService }, { AuthService }] = await Promise.all([
  import('../dist/src/workspace/workspace.module.js'), import('../dist/src/team/team.module.js'),
  import('../dist/src/billing/billing.module.js'), import('../dist/prisma/prisma.service.js'), import('../dist/src/auth/auth.service.js'),
]);
class TestModule {}
Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), WorkspaceModule, TeamModule, BillingModule] })(TestModule);
const app = await NestFactory.create(TestModule, { logger: ['error'] });
app.setGlobalPrefix('api');
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
await app.listen(0, '127.0.0.1');
const base = await app.getUrl();
const prisma = app.get(PrismaService), auth = app.get(AuthService), tag = randomBytes(8).toString('hex');
const nativeFetch = globalThis.fetch;
let passed = 0;
async function call(path, { token, body, method = body === undefined ? 'GET' : 'POST', status = 200 } = {}) {
  const response = await nativeFetch(base + '/api' + path, { method, headers: {
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}),
  }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual' });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
}
async function check(name, action) { await action(); passed++; console.log('PASS ' + name); }
async function account(label) {
  const password = randomBytes(24).toString('base64url') + 'Aa1';
  const user = await prisma.user.create({ data: { email: `${label}.${tag}@example.test`, name: label, passwordHash: await auth.hashPassword(password) } });
  return { ...await auth.buildAuthRdo(user), password };
}
const companyData = { company: 'Integration ' + tag, industry: 'IT и SaaS', employees: '1–5', managers: '1', stage: 'growth' };
async function company(person) {
  const result = await call('/workspace/onboarding/company', { token: person.accessToken, body: companyData });
  const trial = new Date('2026-01-01T00:00:00Z');
  await prisma.user.update({ where: { id: person.user.id }, data: { trialStartedAt: trial } });
  await prisma.workspace.update({ where: { id: result.id }, data: { onboardingComplete: true, diagnosticsComplete: true, isActive: true, trialStartedAt: trial } });
  await prisma.subscription.create({ data: { userId: person.user.id, kind: 'PAID', activeUntil: new Date(Date.now() + 86400000) } });
  const department = await prisma.department.create({ data: { workspaceId: result.id, name: 'Отдел' } });
  return { ...result, departmentId: department.id };
}
async function invitation(owner, workspace, person) {
  const token = randomBytes(32).toString('base64url');
  await prisma.teamInvitation.create({ data: { email: person.user.email, departmentId: workspace.departmentId,
    invitedById: owner.user.id, role: 'WORKER', tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 86400000) } });
  return token;
}
try {
  const owner = await account('owner'), second = await account('second'), employee = await account('employee'), racer = await account('racer');
  const first = await company(owner), other = await company(second);
  await check('one workspace guard and owner-only lifecycle', async () => {
    const conflict = await call('/workspace/onboarding/company', { token: owner.accessToken, body: companyData, status: 409 });
    assert.equal(conflict.code, 'WORKSPACE_MEMBERSHIP_CONFLICT'); assert.equal(conflict.workspace.isOwner, true);
    await call(`/workspace/${first.id}/leave`, { token: owner.accessToken, body: {}, status: 403 });
    await call(`/workspace/${first.id}`, { token: second.accessToken, method: 'DELETE', status: 404 });
  });
  const old = await company(employee);
  const link = await invitation(second, other, employee);
  await check('password invite returns authenticated conflict without consuming the invite', async () => {
    const result = await call(`/invitations/${link}/accept`, { body: { password: employee.password }, status: 409 });
    assert.equal(result.code, 'WORKSPACE_MEMBERSHIP_CONFLICT'); assert.equal(result.workspace.id, old.id);
    assert.equal(result.auth.user.id, employee.user.id);
    assert.equal(await prisma.teamInvitation.count({ where: { email: employee.user.email, acceptedAt: { not: null } } }), 0);
  });
  await check('delete old company then accept with session, preserving paid subscription', async () => {
    await call(`/workspace/${old.id}`, { token: employee.accessToken, method: 'DELETE' });
    const accepted = await call(`/invitations/${link}/accept`, { token: employee.accessToken, body: {} });
    assert.equal(accepted.workspaceId, other.id);
    assert.equal((await call('/workspace/status', { token: employee.accessToken })).workspaceId, other.id);
    assert.equal(await prisma.subscription.count({ where: { userId: employee.user.id } }), 1);
    await call(`/workspace/${old.id}`, { token: employee.accessToken, status: 404 });
  });
  await check('another logged-in account cannot accept an email invitation', async () => {
    const invite = await invitation(owner, first, racer);
    await call(`/invitations/${invite}/accept`, { token: employee.accessToken, body: {}, status: 403 });
  });
  await check('leave removes department and task access and allows another invitation', async () => {
    const task = await prisma.task.create({ data: { workspaceId: other.id, title: 'Scoped task', startDate: new Date(), dueDate: new Date(),
      departments: { create: { departmentId: other.departmentId } }, assignees: { create: { userId: employee.user.id,
        email: employee.user.email, departmentId: other.departmentId } } } });
    await call(`/workspace/${other.id}/leave`, { token: employee.accessToken, body: {} });
    assert.equal(await prisma.taskAssignee.count({ where: { taskId: task.id, userId: employee.user.id } }), 0);
    assert.equal(await prisma.departmentMember.count({ where: { userId: employee.user.id } }), 0);
    assert.equal((await call('/workspace/status', { token: employee.accessToken })).workspaceId, null);
    await call(`/workspace/${other.id}/team`, { token: employee.accessToken, status: 404 });
    const invite = await invitation(owner, first, employee);
    await call(`/invitations/${invite}/accept`, { token: employee.accessToken, body: {} });
  });
  await check('concurrent invitations cannot put one user into two companies', async () => {
    const [a, b] = await Promise.all([invitation(owner, first, racer), invitation(second, other, racer)]);
    const results = await Promise.all([a, b].map(token => nativeFetch(base + `/api/invitations/${token}/accept`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + racer.accessToken }, body: '{}',
    })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    assert.equal(await prisma.workspaceMember.count({ where: { userId: racer.user.id } }), 1);
  });
  await check('workspace deletion revokes everyone and stops jobs without resetting trial', async () => {
    const before = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    await prisma.task.create({ data: { workspaceId: first.id, title: 'Recurring', startDate: new Date(), dueDate: new Date(), repeatDays: [1], nextRepeatAt: new Date() } });
    const unused = await invitation(owner, first, employee);
    await call(`/workspace/${first.id}`, { token: owner.accessToken, method: 'DELETE' });
    await call(`/workspace/${first.id}`, { token: owner.accessToken, method: 'DELETE' });
    assert.equal((await call('/workspace/list', { token: employee.accessToken })).length, 0);
    await call(`/workspace/${first.id}/team`, { token: employee.accessToken, status: 404 });
    await call(`/invitations/${unused}`, { status: 410 });
    assert.equal(await prisma.task.count({ where: { workspaceId: first.id, nextRepeatAt: { not: null } } }), 0);
    const next = await call('/workspace/onboarding/company', { token: owner.accessToken, body: companyData });
    assert.notEqual(next.id, first.id);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: owner.user.id } });
    assert.equal(after.trialStartedAt.toISOString(), before.trialStartedAt.toISOString());
    assert.equal(await prisma.subscription.count({ where: { userId: owner.user.id } }), 1);
  });
  await check('OAuth first link requires confirmed email, then supports password-free invitations', async () => {
    const { OAuthService } = await import('../dist/src/auth/oauth.service.js');
    const oauth = app.get(OAuthService), verifier = randomBytes(32).toString('base64url');
    const start = new URL((await oauth.start('yandex', { codeChallenge: createHash('sha256').update(verifier).digest('base64url'), returnTo: '/partner/account' }, 'integration')).authorizationUrl);
    globalThis.fetch = async (url, options) => {
      if (String(url).startsWith('https://oauth.yandex.ru/token')) return Response.json({ access_token: 'local-provider-token' });
      if (String(url).startsWith('https://login.yandex.ru/info')) return Response.json({ client_id: 'integration-app', id: tag, default_email: second.user.email });
      return nativeFetch(url, options);
    };
    const ticket = await oauth.callback('yandex', { state: start.searchParams.get('state'), code: 'local-provider-code' });
    assert.equal((await call('/auth/oauth/exchange', { body: { ticket, codeVerifier: verifier } })).requiresEmail, true);
    assert.equal(await prisma.oAuthIdentity.count({ where: { subject: tag } }), 0);
    await call('/auth/check-email', { body: { email: second.user.email } });
    const result = await call('/auth/oauth/exchange', { body: { ticket, codeVerifier: verifier, email: second.user.email, code: '111111' } });
    assert.equal(result.user.id, second.user.id); assert.equal(result.returnTo, '/partner/account');
    assert.equal(await prisma.oAuthIdentity.count({ where: { subject: tag } }), 1);
    await call('/auth/oauth/exchange', { body: { ticket, codeVerifier: verifier }, status: 400 });
    globalThis.fetch = nativeFetch;
  });
  console.log(`PASS ${passed} workspace/OAuth integration scenarios`);
} finally { globalThis.fetch = nativeFetch; await app.close(); }
