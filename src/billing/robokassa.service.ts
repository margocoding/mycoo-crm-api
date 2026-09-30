import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';

type PaymentOrder = Prisma.PaymentOrderGetPayload<object>;

type RedirectStatus = 'success' | 'failed' | 'pending';

export interface PaymentOptions {
  email?: string;
  culture?: 'ru' | 'en';
  isTest?: boolean;
  shpParams?: Record<string, string>;
  receipt?: string;
  incCurrLabel?: string;
  modifiers?: string[];
}

@Injectable()
export class RobokassaService {
  private readonly logger = new Logger(RobokassaService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
  ) {}

  private get merchantLogin(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_MERCHANT_LOGIN')?.trim();
  }

  private get password1(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_PASSWORD1')?.trim();
  }

  private get password2(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_PASSWORD2')?.trim();
  }

  private get paymentUrl(): string {
    return 'https://auth.robokassa.ru/Merchant/Index.aspx';
  }

  generatePaymentSignature(
    outSum: string,
    invId: string | number | undefined | null,
    options: Pick<PaymentOptions, 'modifiers' | 'shpParams'> = {},
  ): string {
    const invIdStr = invId ? String(invId) : '';

    const parts: string[] = [this.merchantLogin || '', outSum, invIdStr];

    if (options.modifiers?.length) {
      parts.push(...options.modifiers);
    }

    parts.push(this.password1 || '');

    if (options.shpParams) {
      const sortedShp = Object.entries(options.shpParams)
        .filter(([key]) => key.startsWith('Shp_'))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${key}=${value}`);

      parts.push(...sortedShp);
    }

    return this.md5(parts.join(':')).toUpperCase();
  }

  getPaymentFormData(
    outSum: string,
    invId: string | number | undefined | null,
    description: string,
    options: PaymentOptions = {},
  ): Record<string, string> {
    const modifiers: string[] = [];

    if (options.receipt) {
      modifiers.push(options.receipt);
    }

    if (options.modifiers?.length) {
      modifiers.push(...options.modifiers);
    }

    const signature = this.generatePaymentSignature(outSum, invId, {
      modifiers,
      shpParams: options.shpParams,
    });

    const formData: Record<string, string> = {
      MerchantLogin: this.merchantLogin || '',
      OutSum: outSum,
      Description: description,
      SignatureValue: signature,
    };

    if (invId) {
      formData.InvId = String(invId);
    }

    if (options.email) {
      formData.Email = options.email;
    }

    if (options.culture) {
      formData.Culture = options.culture;
    }

    if (options.isTest !== undefined) {
      formData.IsTest = options.isTest ? '1' : '0';
    }

    if (options.receipt) {
      formData.Receipt = options.receipt;
    }

    if (options.incCurrLabel) {
      formData.IncCurrLabel = options.incCurrLabel;
    }

    if (options.shpParams) {
      for (const [key, value] of Object.entries(options.shpParams)) {
        if (key.startsWith('Shp_')) {
          formData[key] = value;
        }
      }
    }

    return formData;
  }

  getPaymentUrl(
    outSum: string,
    invId: string | number,
    description: string,
    options: Pick<
      PaymentOptions,
      'email' | 'culture' | 'isTest' | 'shpParams'
    > = {},
  ): string {
    const signature = this.generatePaymentSignature(outSum, invId, {
      shpParams: options.shpParams,
    });

    const params = new URLSearchParams({
      MerchantLogin: this.merchantLogin ?? '',
      OutSum: outSum,
      InvId: String(invId),
      Description: description,
      SignatureValue: signature,
    });

    if (options.email) {
      params.set('Email', options.email);
    }

    if (options.culture) {
      params.set('Culture', options.culture);
    }

    if (options.isTest !== undefined) {
      params.set('IsTest', options.isTest ? '1' : '0');
    }

    if (options.shpParams) {
      for (const [key, value] of Object.entries(options.shpParams)) {
        if (key.startsWith('Shp_')) {
          params.set(key, value);
        }
      }
    }

    return `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`;
  }

  async handleResult(
    rawBody?: Record<string, unknown>,
    rawQuery?: Record<string, unknown>,
  ): Promise<string> {
    const params = {
      ...this.normalize(rawQuery),
      ...this.normalize(rawBody),
    };

    const invId = this.pick(params, 'InvId');
    const outSum = this.pick(params, 'OutSum');
    const signature = this.pick(params, 'SignatureValue');
    const merchantLogin = this.pick(params, 'MerchantLogin');
    const currencyParam = this.pick(params, 'Currency');

    if (!invId || !outSum) {
      this.logger.warn('Robokassa result: missing InvId or OutSum');
      return 'bad request';
    }

    if (
      this.merchantLogin &&
      merchantLogin &&
      merchantLogin !== this.merchantLogin
    ) {
      this.logger.warn('Robokassa result: merchant login mismatch');
      return 'bad merchant';
    }

    const order = await this.findOrder(invId);

    if (!order) {
      this.logger.warn(`Robokassa result: order not found: ${invId}`);
      return 'order not found';
    }

    if (order.status === 'PAID') {
      return `OK${invId}`;
    }

    if (
      !this.verifySignature(outSum, invId, signature, this.password2, params)
    ) {
      this.logger.warn(`Robokassa result: bad signature for order ${order.id}`);
      return 'bad sign';
    }

    const amountKopecks = this.toKopecks(outSum);
    const orderCurrency = (order as { currency?: string }).currency ?? 'RUB';
    const currency = currencyParam || orderCurrency;

    if (amountKopecks === null) {
      this.logger.warn(
        `Robokassa result: invalid amount "${outSum}" for order ${order.id}`,
      );
      return 'bad amount';
    }

    if (amountKopecks !== order.amountKopecks || currency !== orderCurrency) {
      this.logger.warn(
        `Robokassa result: amount/currency mismatch for order ${order.id}`,
      );
      return 'bad amount';
    }

    try {
      await this.billing.confirmVerifiedPayment(
        order.id,
        this.providerPaymentId(order.id),
        amountKopecks,
        currency,
      );

      this.logger.log(`Robokassa result confirmed order ${order.id}`);

      return `OK${invId}`;
    } catch (error) {
      const refreshed = await this.findOrder(order.id);

      if (refreshed?.status === 'PAID') {
        return `OK${invId}`;
      }

      this.logger.error(
        'Robokassa result confirmation failed',
        error instanceof Error ? error.stack : String(error),
      );

      return 'error';
    }
  }

  async handleSuccess(rawQuery?: Record<string, unknown>): Promise<string> {
    const params = this.normalize(rawQuery);

    const invId = this.pick(params, 'InvId');
    const outSum = this.pick(params, 'OutSum');
    const signature = this.pick(params, 'SignatureValue');
    const currencyParam = this.pick(params, 'Currency');

    const order = await this.findOrder(invId);

    if (!order) {
      this.logger.error(`Order ${invId} not found`);
      return this.redirectUrl(invId, 'failed');
    }

    if (order.status === 'PAID') {
      return this.redirectUrl(order.id, 'success');
    }

    if (order.status !== 'PENDING') {
      return this.redirectUrl(order.id, 'pending');
    }

    const amountKopecks = this.toKopecks(outSum);
    const orderCurrency = (order as { currency?: string }).currency ?? 'RUB';
    const currency = currencyParam || orderCurrency;

    const signatureValid = this.verifySignature(
      outSum,
      invId,
      signature,
      this.password1,
      params,
    );

    if (
      signatureValid &&
      amountKopecks !== null &&
      amountKopecks === order.amountKopecks &&
      currency === orderCurrency
    ) {
      try {
        await this.billing.confirmVerifiedPayment(
          order.id,
          this.providerPaymentId(order.id),
          amountKopecks,
          currency,
        );

        this.logger.log(
          `Robokassa success fallback confirmed order ${order.id}`,
        );

        return this.redirectUrl(order.id, 'success');
      } catch (error) {
        const refreshed = await this.findOrder(order.id);

        if (refreshed?.status === 'PAID') {
          return this.redirectUrl(order.id, 'success');
        }

        this.logger.error(
          'Robokassa success fallback confirmation failed',
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return this.redirectUrl(order.id, 'pending');
  }

  async handleFail(rawQuery?: Record<string, unknown>): Promise<string> {
    const params = this.normalize(rawQuery);
    const invId = this.pick(params, 'InvId');

    const order = await this.findOrder(invId);

    this.logger.debug(
      `Robokassa fail callback for order ${order?.id ?? invId ?? 'unknown'}`,
    );

    return this.redirectUrl(order?.id ?? invId, 'failed');
  }

  private providerPaymentId(orderId: string): string {
    return `robokassa:${orderId}`;
  }

  private async findOrder(invId?: string): Promise<PaymentOrder | null> {
    if (!invId) {
      console.error('No inv id')
      return null;
    }

    try {
      return await this.prisma.paymentOrder.findUnique({
        where: { orderId: +invId },
      });
    } catch(e) {
      console.error(e);
      return null;
    }
  }

  private normalize(input?: Record<string, unknown>): Record<string, string> {
    const output: Record<string, string> = {};

    if (!input) {
      return output;
    }

    for (const [key, value] of Object.entries(input)) {
      if (Array.isArray(value)) {
        output[key] = String(value[0] ?? '');
      } else if (value !== null && value !== undefined) {
        output[key] = String(value);
      }
    }

    return output;
  }

  private pick(
    params: Record<string, string>,
    name: string,
  ): string | undefined {
    if (params[name] !== undefined) {
      return params[name];
    }

    const lowerName = name.toLowerCase();

    const entry = Object.entries(params).find(
      ([key]) => key.toLowerCase() === lowerName,
    );

    return entry?.[1];
  }

  private md5(value: string): string {
    return createHash('md5').update(value, 'utf8').digest('hex');
  }

  private safeEqual(a?: string, b?: string): boolean {
    if (typeof a !== 'string' || typeof b !== 'string') {
      return false;
    }

    const bufferA = Buffer.from(a, 'utf8');
    const bufferB = Buffer.from(b, 'utf8');

    if (bufferA.length !== bufferB.length) {
      return false;
    }

    return timingSafeEqual(bufferA, bufferB);
  }

  private makeCallbackSignature(
    outSum: string,
    invId: string,
    password: string,
    params: Record<string, string>,
  ): string {
    const shpEntries = Object.entries(params)
      .filter(([key]) => key.startsWith('Shp_'))
      .sort(([a], [b]) => a.localeCompare(b));

    const baseString = `${outSum}:${invId}:${password}`;

    const shpString =
      shpEntries.length > 0
        ? `:${shpEntries.map(([key, value]) => `${key}=${value}`).join(':')}`
        : '';

    return this.md5(`${baseString}${shpString}`);
  }

  private verifySignature(
    outSum?: string,
    invId?: string,
    signature?: string,
    password?: string,
    params?: Record<string, string>,
  ): boolean {
    if (!invId || !outSum || !signature || !password) {
      return false;
    }

    const expected = this.makeCallbackSignature(
      outSum,
      invId,
      password,
      params || {},
    ).toLowerCase();

    const actual = signature.toLowerCase();

    return this.safeEqual(expected, actual);
  }

  private toKopecks(value?: string): number | null {
    if (!value) {
      return null;
    }

    const normalized = value.trim().replace(/\s+/g, '').replace(',', '.');

    if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
      return null;
    }

    const amount = Number(normalized);

    if (!Number.isFinite(amount)) {
      return null;
    }

    return Math.round(amount * 100);
  }

  private redirectUrl(
    orderId?: string,
    status: RedirectStatus = 'pending',
  ): string {
    const base =
      this.config.get<string>('FRONTEND_URL')?.trim() ||
      'https://mycoo.io';

    let url: URL;

    try {
      url = new URL(base);
    } catch {
      url = new URL('https://mycoo.io');
    }

    url.pathname = this.config.get<string>('BILLING_RETURN_PATH', '/dashboard');
    url.search = '';
    url.hash = '';

    url.searchParams.set('payment', status);

    if (orderId) {
      url.searchParams.set('orderId', orderId);
    }

    return url.toString();
  }
}
