import { BadRequestException, ConflictException, HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { RedisService } from '../redis/redis.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuthService } from './auth.service.js';
import { BillingService } from '../billing/billing.service.js';
import { PartnerService } from '../partners/partner.service.js';
import type { OAuthExchangeDto, OAuthStartDto } from './oauth.dto.js';

type Provider = 'yandex' | 'vk';
type Flow = OAuthStartDto & { provider: Provider; providerVerifier: string; returnTo: string };
type Ticket = Omit<Flow, 'providerVerifier'> & { subject: string; email?: string; name?: string };
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
const key = (type: string, value: string) => `oauth:${type}:${digest(value)}`;
export function safeReturnTo(value?: string) {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\') || [...value].some(c => c.charCodeAt(0) <= 32)) return '/';
  const url = new URL(value, 'https://mycoo.invalid');
  return url.origin === 'https://mycoo.invalid' ? url.pathname + url.search + url.hash : '/';
}

@Injectable()
export class OAuthService {
  constructor(private readonly config: ConfigService, private readonly redis: RedisService,
    private readonly prisma: PrismaService, private readonly auth: AuthService,
    private readonly billing: BillingService, private readonly partners: PartnerService) {}

  private provider(value: string): Provider {
    if (value !== 'yandex' && value !== 'vk') throw new BadRequestException('Неизвестный способ входа.');
    return value;
  }
  private settings(provider: Provider) {
    const prefix = provider === 'yandex' ? 'YANDEX_ID' : 'VK_ID';
    const clientId = this.config.get<string>(prefix + '_CLIENT_ID', '').trim();
    const secret = this.config.get<string>(prefix + '_CLIENT_SECRET', '').trim();
    const redirectUri = this.config.get<string>(prefix + '_REDIRECT_URI', '').trim();
    let valid = false;
    try {
      const url = new URL(redirectUri);
      valid = !url.username && !url.password && (url.protocol === 'https:' ||
        (this.config.get('NODE_ENV') !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)));
    } catch { /* An unconfigured provider stays disabled. */ }
    return { clientId, secret, redirectUri, enabled: Boolean(clientId && valid) };
  }
  providers() {
    return (['yandex', 'vk'] as const).map(id => ({ id, name: id === 'yandex' ? 'Яндекс ID' : 'VK ID', enabled: this.settings(id).enabled }));
  }
  async start(value: string, dto: OAuthStartDto, ip: string) {
    const provider = this.provider(value);
    const config = this.settings(provider);
    if (!config.enabled) throw new ServiceUnavailableException('Этот способ входа пока не настроен. Войдите по почте.');
    if (await this.redis.countAttempt(key('start', ip), 600) > 30) throw new HttpException('Слишком много попыток входа. Попробуйте позже.', 429);
    const state = random();
    const providerVerifier = random();
    await this.redis.setJson(key('state', state), { ...dto, provider, providerVerifier, returnTo: safeReturnTo(dto.returnTo) } satisfies Flow, 600);
    const url = new URL(provider === 'yandex' ? 'https://oauth.yandex.ru/authorize' : 'https://id.vk.ru/authorize');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
      response_type: 'code', state, code_challenge: digest(providerVerifier), code_challenge_method: provider === 'vk' ? 's256' : 'S256',
      scope: provider === 'yandex' ? 'login:email login:info' : 'email',
    }).toString();
    return { authorizationUrl: url.toString() };
  }
  private async json(url: string, init: RequestInit) {
    try {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'error' });
      if (!response.ok) throw new Error('OAuth upstream rejected request');
      const data = await response.json();
      if (!data || typeof data !== 'object' || data.error) throw new Error('OAuth provider error');
      return data;
    } catch { throw new ServiceUnavailableException('Сервис входа временно недоступен. Начните вход заново или используйте почту.'); }
  }
  private form(body: Record<string, string>): RequestInit {
    return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) };
  }
  async callback(value: string, query: Record<string, unknown>) {
    const provider = this.provider(value);
    const state = typeof query.state === 'string' ? query.state : '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new BadRequestException('Ссылка входа недействительна.');
    const flow = await this.redis.takeJson<Flow>(key('state', state));
    if (!flow || flow.provider !== provider) throw new BadRequestException('Ссылка входа устарела или уже использована.');
    if (query.error || typeof query.code !== 'string' || !query.code || query.code.length > 4096)
      throw new BadRequestException('Вход отменён. Попробуйте ещё раз.');
    const config = this.settings(provider);
    if (!config.enabled) throw new ServiceUnavailableException('Вход временно недоступен.');
    let subject: string, email: unknown, name: unknown;
    if (provider === 'yandex') {
      const token = await this.json('https://oauth.yandex.ru/token', this.form({ grant_type: 'authorization_code', code: query.code,
        client_id: config.clientId, code_verifier: flow.providerVerifier, ...(config.secret ? { client_secret: config.secret } : {}) }));
      if (typeof token.access_token !== 'string' || !token.access_token) throw new BadRequestException('Не удалось подтвердить вход.');
      const user = await this.json('https://login.yandex.ru/info?format=json', { headers: { Authorization: 'OAuth ' + token.access_token } });
      if (String(user.client_id) !== config.clientId) throw new BadRequestException('Ответ предназначен другому приложению.');
      subject = String(user.id ?? ''); email = user.default_email; name = user.real_name || user.display_name;
    } else {
      if (typeof query.device_id !== 'string' || !query.device_id || query.device_id.length > 1024)
        throw new BadRequestException('VK ID не вернул идентификатор устройства. Начните вход заново.');
      const token = await this.json('https://id.vk.ru/oauth2/auth', this.form({ grant_type: 'authorization_code', code: query.code,
        client_id: config.clientId, redirect_uri: config.redirectUri, state, device_id: query.device_id, code_verifier: flow.providerVerifier }));
      if (token.state !== state || typeof token.access_token !== 'string' || !token.access_token)
        throw new BadRequestException('Не удалось подтвердить ответ VK ID.');
      const data = await this.json('https://id.vk.ru/oauth2/user_info', this.form({ client_id: config.clientId, access_token: token.access_token }));
      const user = data.user;
      if (!user || String(user.user_id) !== String(token.user_id)) throw new BadRequestException('Не удалось подтвердить пользователя VK ID.');
      subject = String(user.user_id ?? ''); email = user.email; name = [user.first_name, user.last_name].filter(x => typeof x === 'string').join(' ');
    }
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(subject)) throw new BadRequestException('Сервис входа не вернул пользователя.');
    const ticket = random();
    const { providerVerifier: _secret, ...rest } = flow;
    await this.redis.setJson(key('ticket', ticket), { ...rest, subject,
      ...(typeof email === 'string' && email.length <= 254 ? { email } : {}),
      ...(typeof name === 'string' ? { name: name.slice(0, 120) } : {}) } satisfies Ticket, 600);
    return ticket;
  }
  frontendCallback(params: Record<string, string>) {
    const url = new URL('/auth/oauth/callback', this.config.get<string>('APP_URL', 'https://mycoo.io'));
    url.search = new URLSearchParams(params).toString();
    return url.toString();
  }
  async exchange(dto: OAuthExchangeDto) {
    const ticketKey = key('ticket', dto.ticket);
    const flow = await this.redis.getJson<Ticket>(ticketKey);
    const proof = digest(dto.codeVerifier);
    if (!flow || flow.codeChallenge.length !== proof.length || !timingSafeEqual(Buffer.from(flow.codeChallenge), Buffer.from(proof)))
      throw new BadRequestException('Вход начат в другой вкладке или ссылка устарела. Начните заново.');
    if (!await this.redis.setNxEx(ticketKey + ':lock', 30)) throw new ConflictException('Вход уже обрабатывается.');
    try {
      const identity = await this.prisma.oAuthIdentity.findUnique({ where: { provider_subject: { provider: flow.provider, subject: flow.subject } }, include: { user: true } });
      let user = identity?.user;
      if (!user) {
        if (!dto.email || !dto.code) return { requiresEmail: true, email: flow.email };
        const email = dto.email.trim().toLowerCase();
        await this.auth.confirmOAuthEmail(email, dto.code);
        const passwordHash = await this.auth.hashPassword(randomBytes(48).toString('base64url'));
        user = await this.prisma.$transaction(async tx => {
          await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', 'oauth:' + flow.provider + ':' + flow.subject);
          const linked = await tx.oAuthIdentity.findUnique({ where: { provider_subject: { provider: flow.provider, subject: flow.subject } } });
          if (linked) throw new ConflictException('Аккаунт уже привязан. Начните вход заново.');
          let account = await tx.user.findUnique({ where: { email } });
          if (!account) {
            account = await tx.user.create({ data: { email, name: flow.name, passwordHash } });
            await this.billing.creditReferral(tx, account.id, flow.referralCode);
            await this.partners.attachReferral(tx, account.id, flow.partnerCode);
          }
          await tx.oAuthIdentity.create({ data: { provider: flow.provider, subject: flow.subject, userId: account.id } });
          return account;
        }).catch(error => {
          if (error?.code === 'P2002') throw new ConflictException('Этот аккаунт уже связан со способом входа. Начните вход заново.');
          throw error;
        });
      }
      const result = await this.auth.buildAuthRdo(user);
      if (!await this.redis.takeJson(ticketKey)) throw new BadRequestException('Ссылка уже использована.');
      return { ...result, returnTo: flow.returnTo };
    } finally { await this.redis.delete(ticketKey + ':lock'); }
  }
}
