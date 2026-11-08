// Run after build/migrate against an isolated local PostgreSQL database and Redis.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Module, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';

const db = new URL(process.env.DATABASE_URL || 'postgresql://postgres@127.0.0.1:5548/mycoo_partner_test');
assert(['127.0.0.1', 'localhost'].includes(db.hostname) && /test/.test(db.pathname), 'Use an isolated local test database');
const redisUrl = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6388/1');
assert(['127.0.0.1', 'localhost'].includes(redisUrl.hostname), 'Use local test Redis');
Object.assign(process.env, {
  DATABASE_URL: db.href, REDIS_URL: redisUrl.href, NODE_ENV: 'development',
  JWT_SECRET: randomBytes(32).toString('hex'), BCRYPT_SALT_ROUNDS: '4', SMTP_HOST: '',
  ROBO_KASSA_MERCHANT_LOGIN: 'integration', ROBO_KASSA_PASSWORD1: randomUUID(), ROBO_KASSA_PASSWORD2: randomUUID(),
  ROBO_KASSA_TEST_MODE: 'true',
  ROBO_KASSA_RESULT_URL: 'http://127.0.0.1/test', ROBO_KASSA_SUCCESS_URL: 'http://127.0.0.1/test', ROBO_KASSA_FAIL_URL: 'http://127.0.0.1/test',
});
const [{ PartnerModule }, { BillingModule }, { PrismaService }, { PartnerService }, { hashPartnerAdminPassword }] = await Promise.all([
  import('../dist/src/partners/partner.module.js'), import('../dist/src/billing/billing.module.js'),
  import('../dist/prisma/prisma.service.js'), import('../dist/src/partners/partner.service.js'),
  import('../dist/src/partners/partner-admin-auth.service.js'),
]);
class TestModule {}
Module({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PartnerModule, BillingModule] })(TestModule);
const app = await NestFactory.create(TestModule, { logger: false });
app.setGlobalPrefix('api');
app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
await app.listen(0, '127.0.0.1');
const base = await app.getUrl();
const prisma = app.get(PrismaService), service = app.get(PartnerService);
const tag = randomBytes(6).toString('hex');
const checks = [];
async function check(name, action) { await action(); checks.push(name); console.log(`PASS ${name}`); }
async function call(path, { token, body, method = body ? 'POST' : 'GET', status } = {}) {
  const response = await fetch(`${base}/api${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await response.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (status !== undefined) assert.equal(response.status, status, `${method} ${path}: ${text}`);
  else assert(response.ok, `${method} ${path}: ${response.status} ${text}`);
  return data;
}
async function register(label, partnerCode, referralCode) {
  const email = `${label}.${tag}@example.test`;
  await call('/auth/check-email', { body: { email } });
  return call('/auth/register', { body: { email, password: `Integration9${tag}`, code: '111111', ...(partnerCode ? { partnerCode } : {}), ...(referralCode ? { referralCode } : {}) } });
}
const details = { recipient: 'Тестовый партнёр', taxId: '123456789012', bank: 'Тестовый банк', account: '40817810000000000001', bic: '044525225', legalForm: 'self-employed' };
let partner, outsider, client, partnerId, referral, adminToken, payment, payoutId;
let maturePartner, matureReferral, maturePaymentId, pendingPayoutId, approvedPayoutId;
const adminLogin = `test.${tag}`, password = `Admin9${tag}`;
try {
  await check('public terms and authentication boundary', async () => {
    const terms = await call('/partners/terms'); assert(terms.minimumPayout > 0);
    await call('/partners/me', { status: 401 }); await call('/partner-admin/data', { status: 401 });
  });
  await check('verified account registration and immediate enrollment', async () => {
    partner = await register('partner'); outsider = await register('outsider');
    assert.equal((await call('/partners/me', { token: partner.accessToken })).currentPartnerId, '');
    const result = await call('/partners/register', { token: partner.accessToken, body: { name: 'Тестовый партнёр', company: 'Партнёрская компания' } });
    assert(result.ok); partnerId = result.id;
    const second = await call('/partners/register', { token: partner.accessToken, body: { name: 'Тестовый партнёр', company: 'Партнёрская компания' } });
    assert.equal(second.id, partnerId);
  });
  await check('referral attribution, safe company data and old referral discount', async () => {
    const own = await call('/partners/me', { token: partner.accessToken });
    const billing = await call('/billing/me', { token: outsider.accessToken });
    const code = new URL(billing.referral.url).searchParams.get('ref');
    client = await register('client', own.partners[0].code, code);
    await prisma.workspace.create({ data: { ownerId: client.user.id, company: 'Компания клиента', ownerEmail: client.user.email, ownerName: 'Private client name' } });
    const data = await call('/partners/me', { token: partner.accessToken });
    assert.equal(data.referrals.length, 1); referral = data.referrals[0];
    assert.equal(referral.company, 'Компания клиента');
    assert(!JSON.stringify(data).includes(client.user.email)); assert(!JSON.stringify(data).includes(client.user.id));
    assert.equal((await call('/billing/me', { token: outsider.accessToken })).referral.earnedDiscounts, 1);
    await prisma.$transaction(tx => service.attachReferral(tx, partner.user.id, own.partners[0].code));
    assert.equal(await prisma.partnerReferral.count({ where: { referredUserId: partner.user.id } }), 0);
  });
  await check('ordinary user cannot read or mutate administration', async () => {
    await call('/partner-admin/data', { token: partner.accessToken, status: 401 });
    await call('/partner-admin/terms', { method: 'PUT', token: partner.accessToken, body: { commissionPercent: 99, eligibleMonths: 12, holdDays: 0, minimumPayout: 1 }, status: 401 });
    const own = await call('/partners/me', { token: outsider.accessToken }); assert.equal(own.referrals.length, 0); assert.equal(own.partners.length, 0);
    await call('/partners/me/payouts', { token: outsider.accessToken, body: { partnerId, amount: 5000, idempotencyKey: randomUUID() }, status: 400 });
  });
  await check('server administrator login and invalid credentials', async () => {
    await prisma.partnerAdmin.create({ data: { login: adminLogin, passwordHash: await hashPartnerAdminPassword(password) } });
    await call('/partner-admin/login', { body: { login: adminLogin, password: 'bad' }, status: 401 });
    adminToken = (await call('/partner-admin/login', { body: { login: adminLogin, password } })).token;
    assert.equal((await call('/partner-admin/session', { token: adminToken })).login, adminLogin);
    await call('/partners/me', { token: adminToken, status: 401 });
    await call('/partner-admin/terms', { method: 'PUT', token: adminToken, body: { commissionPercent: 20, eligibleMonths: 12, holdDays: 14, minimumPayout: 5000 } });
  });
  await check('test payment callbacks never accrue commission and checkout preserves the stored payment mode', async () => {
    const request = { plan: 'START', period: 'MONTH', idempotencyKey: randomUUID() };
    const checkout = await call('/billing/orders', { token: client.accessToken, body: request });
    const order = await prisma.paymentOrder.findUniqueOrThrow({ where: { id: checkout.orderId } });
    assert.equal(order.isTest, true); assert.equal(new URL(checkout.checkoutUrl).searchParams.get('IsTest'), '1');
    process.env.ROBO_KASSA_TEST_MODE = 'false';
    const reopened = await call('/billing/orders', { token: client.accessToken, body: request });
    assert.equal(new URL(reopened.checkoutUrl).searchParams.get('IsTest'), '1');
    const liveCheckout = await call('/billing/orders', { token: client.accessToken, body: { ...request, idempotencyKey: randomUUID() } });
    assert.equal((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: liveCheckout.orderId } })).isTest, false);
    assert.equal(new URL(liveCheckout.checkoutUrl).searchParams.get('IsTest'), null);
    const OutSum = (order.amountKopecks / 100).toFixed(2), InvId = String(order.orderId);
    const SignatureValue = createHash('md5').update(`${OutSum}:${InvId}:${process.env.ROBO_KASSA_PASSWORD2}`).digest('hex');
    for (let attempt = 0; attempt < 2; attempt++) assert.equal(await call('/billing/payments/robokassa/result', { body: { OutSum, InvId, SignatureValue } }), `OK${InvId}`);
    assert.equal((await prisma.paymentOrder.findUniqueOrThrow({ where: { id: order.id } })).status, 'PAID');
    assert.equal(await prisma.partnerPayment.count({ where: { orderId: order.id } }), 0);
    const data = await call('/partners/me', { token: partner.accessToken });
    assert.equal(data.payments.length, 0); assert.equal(data.ledger.length, 0);
  });
  await check('signed live payment callback credits exactly once concurrently', async () => {
    const order = await prisma.paymentOrder.create({ data: { userId: client.user.id, plan: 'START', period: 'MONTH', isTest: false, amountKopecks: 5000000, idempotencyKey: randomUUID() } });
    const OutSum = '50000.00', InvId = String(order.orderId);
    const SignatureValue = createHash('md5').update(`${OutSum}:${InvId}:${process.env.ROBO_KASSA_PASSWORD2}`).digest('hex');
    const invalid = await call('/billing/payments/robokassa/result', { body: { OutSum, InvId, SignatureValue: 'wrong' } }); assert.equal(invalid, 'bad sign');
    assert.equal(await prisma.partnerPayment.count({ where: { orderId: order.id } }), 0);
    const replies = await Promise.all(Array.from({ length: 3 }, () => call('/billing/payments/robokassa/result', { body: { OutSum, InvId, SignatureValue } })));
    replies.forEach(reply => assert.equal(reply, `OK${InvId}`));
    assert.equal(await prisma.partnerPayment.count({ where: { orderId: order.id } }), 1);
    const data = await call('/partners/me', { token: partner.accessToken }); payment = data.payments[0];
    assert.equal(data.ledger.filter(entry => entry.kind === 'commission').length, 1); assert.equal(data.ledger[0].amount, 10000);
    assert.equal((await prisma.paymentOrder.findUnique({ where: { id: order.id } })).status, 'PAID');
  });
  await check('hold blocks withdrawal and payment details required', async () => {
    await call('/partners/me/payouts', { token: partner.accessToken, body: { amount: 5000, idempotencyKey: randomUUID() }, status: 400 });
    await call('/partners/me/details', { method: 'PUT', token: partner.accessToken, body: details });
    await call('/partners/me/payouts', { token: partner.accessToken, body: { amount: 5000, idempotencyKey: randomUUID() }, status: 409 });
  });
  await check('available corrections reserve once and parallel requests cannot overspend', async () => {
    const adjustment = { partnerId, amount: 10000, description: 'Сверка тестовой операции', idempotencyKey: randomUUID() };
    const replies = await Promise.all([0, 1].map(() => call('/partner-admin/adjustments', { token: adminToken, body: adjustment })));
    assert.equal(replies[0].id, replies[1].id);
    await call('/partner-admin/adjustments', { token: adminToken, body: { ...adjustment, amount: 20000 }, status: 409 });
    const requests = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${base}/api/partners/me/payouts`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${partner.accessToken}` }, body: JSON.stringify({ amount: 6000, idempotencyKey: randomUUID() }) });
      return { status: response.status, data: await response.json() };
    }));
    assert.equal(requests.filter(r => r.status < 300).length, 1); assert.equal(requests.filter(r => r.status === 409).length, 1);
    payoutId = requests.find(r => r.status < 300).data.id;
    const data = await call('/partners/me', { token: partner.accessToken }); assert.equal(data.payouts.length, 1);
  });
  await check('payout detail snapshot, review and partial payment', async () => {
    await call('/partners/me/details', { method: 'PUT', token: partner.accessToken, body: { ...details, recipient: 'Изменённый получатель' } });
    assert.equal((await call('/partners/me', { token: partner.accessToken })).payouts[0].details.recipient, details.recipient);
    await call(`/partner-admin/payouts/${payoutId}/pay`, { token: adminToken, body: { amount: 5500, date: new Date().toISOString(), idempotencyKey: randomUUID() }, status: 409 });
    await call(`/partner-admin/payouts/${payoutId}/review`, { token: adminToken, body: { status: 'review' } });
    await call(`/partner-admin/payouts/${payoutId}/review`, { token: adminToken, body: { status: 'approved' } });
    const pay = { amount: 5500, date: new Date().toISOString(), idempotencyKey: randomUUID() };
    await call(`/partner-admin/payouts/${payoutId}/pay`, { token: adminToken, body: pay });
    await call(`/partner-admin/payouts/${payoutId}/pay`, { token: adminToken, body: pay });
    const data = await call('/partners/me', { token: partner.accessToken }); assert.equal(data.payouts[0].paidAmount, 5500); assert.equal(data.payouts[0].status, 'paid');
  });
  await check('partial refunds reverse original commission and reject duplicate payload changes', async () => {
    const refund = { amount: 10000, reason: 'Частичный возврат', idempotencyKey: randomUUID() };
    await call(`/partner-admin/payments/${payment.id}/refunds`, { token: adminToken, body: refund });
    await call(`/partner-admin/payments/${payment.id}/refunds`, { token: adminToken, body: refund });
    await call(`/partner-admin/payments/${payment.id}/refunds`, { token: adminToken, body: { ...refund, amount: 20000 }, status: 409 });
    const data = await call('/partners/me', { token: partner.accessToken });
    assert.equal(data.payments[0].refundedAmount, 10000); assert.equal(data.ledger.filter(item => item.kind === 'refund').reduce((sum, item) => sum + item.amount, 0), -2000);
    await call(`/partner-admin/payments/${payment.id}/refunds`, { token: adminToken, body: { ...refund, amount: 50000, idempotencyKey: randomUUID() }, status: 400 });
  });
  await check('changed program terms do not change the original refund commission rate', async () => {
    await call('/partner-admin/terms', { method: 'PUT', token: adminToken, body: { commissionPercent: 65, eligibleMonths: 12, holdDays: 0, minimumPayout: 1000 } });
    await call(`/partner-admin/payments/${payment.id}/refunds`, { token: adminToken, body: { amount: 5000, reason: 'Возврат после изменения ставки', idempotencyKey: randomUUID() } });
    const data = await call('/partners/me', { token: partner.accessToken });
    assert.equal(data.payments.find(item => item.id === payment.id).refundedAmount, 15000);
    assert.equal(data.ledger.filter(item => item.kind === 'refund' && item.paymentId === payment.id).reduce((sum, item) => sum + item.amount, 0), -3000);
    assert.equal(data.terms.commissionPercent, 65);
  });
  await check('historical payment matures real commission and manual payment IDs cannot be duplicated or spoofed', async () => {
    await call('/partner-admin/terms', { method: 'PUT', token: adminToken, body: { commissionPercent: 20, eligibleMonths: 12, holdDays: 14, minimumPayout: 1000 } });
    maturePartner = await register('mature-partner');
    await call('/partners/register', { token: maturePartner.accessToken, body: { name: 'Партнёр с историей', company: '' } });
    const profile = await call('/partners/me', { token: maturePartner.accessToken });
    const matureClient = await register('mature-client', profile.partners[0].code);
    const historyStart = new Date(Date.now() - 40 * 86400000);
    matureReferral = await prisma.partnerReferral.update({ where: { referredUserId: matureClient.user.id }, data: { registeredAt: historyStart } });
    await call('/partners/me/details', { method: 'PUT', token: maturePartner.accessToken, body: details });
    maturePaymentId = `history-${tag}`;
    const body = { referralId: matureReferral.id, paymentId: maturePaymentId, amount: 50000, date: new Date(Date.now() - 20 * 86400000).toISOString(), idempotencyKey: randomUUID() };
    await call('/partner-admin/payments', { token: adminToken, body });
    await call('/partner-admin/payments', { token: adminToken, body });
    await call('/partner-admin/payments', { token: adminToken, body: { ...body, idempotencyKey: randomUUID() }, status: 409 });
    await call('/partner-admin/payments', { token: adminToken, body: { ...body, paymentId: `order:forged-${tag}`, idempotencyKey: randomUUID() }, status: 400 });
    const data = await call('/partners/me', { token: maturePartner.accessToken });
    assert.equal(data.payments.length, 1); assert.equal(data.ledger.length, 1);
    assert.equal(data.ledger[0].kind, 'commission'); assert.equal(data.ledger[0].amount, 10000);
    assert(new Date(data.ledger[0].availableAt) < new Date());
  });
  await check('payout rejection requires a reason and releases the full reservation', async () => {
    const first = await call('/partners/me/payouts', { token: maturePartner.accessToken, body: { amount: 6000, idempotencyKey: randomUUID() } });
    await call('/partners/me/payouts', { token: maturePartner.accessToken, body: { amount: 6000, idempotencyKey: randomUUID() }, status: 409 });
    await call(`/partner-admin/payouts/${first.id}/review`, { token: adminToken, body: { status: 'rejected' }, status: 400 });
    await call(`/partner-admin/payouts/${first.id}/review`, { token: adminToken, body: { status: 'rejected', reason: 'Партнёр запросил другую сумму' } });
    const replacement = await call('/partners/me/payouts', { token: maturePartner.accessToken, body: { amount: 5000, idempotencyKey: randomUUID() } });
    await call(`/partner-admin/payouts/${replacement.id}/review`, { token: adminToken, body: { status: 'approved' } });
    await call(`/partner-admin/payouts/${replacement.id}/pay`, { token: adminToken, body: { amount: 3000, date: new Date().toISOString(), idempotencyKey: randomUUID() } });
    pendingPayoutId = (await call('/partners/me/payouts', { token: maturePartner.accessToken, body: { amount: 2000, idempotencyKey: randomUUID() } })).id;
    approvedPayoutId = (await call('/partners/me/payouts', { token: maturePartner.accessToken, body: { amount: 2000, idempotencyKey: randomUUID() } })).id;
    await call(`/partner-admin/payouts/${approvedPayoutId}/review`, { token: adminToken, body: { status: 'approved' } });
    const data = await call('/partners/me', { token: maturePartner.accessToken });
    assert.equal(data.payouts.find(item => item.id === first.id).reviewNote, 'Партнёр запросил другую сумму');
    assert.equal(data.payouts.find(item => item.id === replacement.id).paidAmount, 3000);
  });
  await check('full refund after payout retains debt and blocks new withdrawals, approval and payment', async () => {
    await call(`/partner-admin/payments/${maturePaymentId}/refunds`, { token: adminToken, body: { amount: 50000, reason: 'Полный возврат после выплаты комиссии', idempotencyKey: randomUUID() } });
    const data = await call('/partners/me', { token: maturePartner.accessToken });
    const matured = data.ledger.filter(item => new Date(item.availableAt) <= new Date()).reduce((sum, item) => sum + item.amount, 0);
    const paid = data.payouts.filter(item => item.status === 'paid').reduce((sum, item) => sum + item.paidAmount, 0);
    const reserved = data.payouts.filter(item => ['new', 'review', 'approved'].includes(item.status)).reduce((sum, item) => sum + item.amount, 0);
    assert.equal(matured, 0); assert.equal(paid, 3000); assert.equal(matured - paid - reserved, -7000);
    await call('/partners/me/payouts', { token: maturePartner.accessToken, body: { amount: 1000, idempotencyKey: randomUUID() }, status: 409 });
    await call(`/partner-admin/payouts/${pendingPayoutId}/review`, { token: adminToken, body: { status: 'approved' }, status: 409 });
    await call(`/partner-admin/payouts/${approvedPayoutId}/pay`, { token: adminToken, body: { amount: 2000, date: new Date().toISOString(), idempotencyKey: randomUUID() }, status: 409 });
    const after = await call('/partners/me', { token: maturePartner.accessToken });
    assert.equal(after.payouts.find(item => item.id === pendingPayoutId).status, 'new');
    assert.equal(after.payouts.find(item => item.id === approvedPayoutId).status, 'approved');
  });
  await check('concurrent partial refunds cannot exceed the payment and sum to the original commission', async () => {
    const paymentId = `concurrent-${tag}`;
    await call('/partner-admin/payments', { token: adminToken, body: { referralId: matureReferral.id, paymentId, amount: 100, date: new Date().toISOString(), idempotencyKey: randomUUID() } });
    const responses = await Promise.all([0, 1].map(async () => {
      const response = await fetch(`${base}/api/partner-admin/payments/${paymentId}/refunds`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ amount: 70, reason: 'Конкурентный возврат', idempotencyKey: randomUUID() }) });
      return { status: response.status, data: await response.json() };
    }));
    assert.equal(responses.filter(item => item.status < 300).length, 1); assert.equal(responses.filter(item => item.status === 400).length, 1);
    await call(`/partner-admin/payments/${paymentId}/refunds`, { token: adminToken, body: { amount: 30, reason: 'Возврат остатка', idempotencyKey: randomUUID() } });
    const data = await call('/partners/me', { token: maturePartner.accessToken });
    assert.equal(data.payments.find(item => item.id === paymentId).refundedAmount, 100);
    assert.equal(data.ledger.filter(item => item.kind === 'refund' && item.paymentId === paymentId).reduce((sum, item) => sum + item.amount, 0), -20);
    assert.equal(await prisma.partnerOperation.count({ where: { kind: 'refund', resultId: paymentId } }), 2);
  });
  await check('zero-commission refunds still preserve amount and reason in immutable operation history', async () => {
    await call('/partner-admin/terms', { method: 'PUT', token: adminToken, body: { commissionPercent: 0, eligibleMonths: 12, holdDays: 0, minimumPayout: 5000 } });
    const paymentId = `zero-${tag}`;
    await call('/partner-admin/payments', { token: adminToken, body: { referralId: matureReferral.id, paymentId, amount: 100, date: new Date().toISOString(), idempotencyKey: randomUUID() } });
    const reason = 'Возврат при нулевой комиссии';
    await call(`/partner-admin/payments/${paymentId}/refunds`, { token: adminToken, body: { amount: 15, reason, idempotencyKey: randomUUID() } });
    const operation = await prisma.partnerOperation.findFirstOrThrow({ where: { kind: 'refund', resultId: paymentId } });
    assert.deepEqual(operation.payload, { paymentId, amountKopecks: 1500, reason });
    const stored = await prisma.partnerPayment.findUniqueOrThrow({ where: { externalId: paymentId } });
    assert.equal(stored.commissionKopecks, 0); assert.equal(stored.refundedKopecks, 1500);
    assert.equal(await prisma.partnerLedgerEntry.count({ where: { paymentId: stored.id } }), 0);
    await assert.rejects(prisma.partnerOperation.update({ where: { id: operation.id }, data: { payload: {} } }));
    await assert.rejects(prisma.partnerOperation.delete({ where: { id: operation.id } }));
    await call('/partner-admin/terms', { method: 'PUT', token: adminToken, body: { commissionPercent: 20, eligibleMonths: 12, holdDays: 14, minimumPayout: 5000 } });
  });
  await check('journal and operation history cannot be edited or deleted', async () => {
    const entry = await prisma.partnerLedgerEntry.findFirstOrThrow({ where: { partnerId } });
    await assert.rejects(prisma.partnerLedgerEntry.update({ where: { id: entry.id }, data: { amountKopecks: 1 } }));
    await assert.rejects(prisma.partnerLedgerEntry.delete({ where: { id: entry.id } }));
    assert((await prisma.partnerPayoutEvent.count({ where: { payoutId } })) >= 4);
  });
  await check('credential rotation revokes all old sessions and logout revokes new one', async () => {
    const second = await call('/partner-admin/login', { body: { login: adminLogin, password } });
    const rotated = await call('/partner-admin/credentials', { method: 'PUT', token: adminToken, body: { currentPassword: password, login: `${adminLogin}.new`, password: `${password}new` } });
    await call('/partner-admin/session', { token: adminToken, status: 401 }); await call('/partner-admin/session', { token: second.token, status: 401 });
    assert.equal((await call('/partner-admin/session', { token: rotated.token })).login, `${adminLogin}.new`);
    await call('/partner-admin/logout', { token: rotated.token, body: {} }); await call('/partner-admin/data', { token: rotated.token, status: 401 });
  });
  console.log(`Passed ${checks.length} partner integration scenarios.`);
} finally { await app.close(); }
