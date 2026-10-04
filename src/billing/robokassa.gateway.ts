import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { PLANS } from './billing.plans.js';
import { createHash } from 'crypto';

type PaymentOrder = Prisma.PaymentOrderGetPayload<object>;

@Injectable()
export class RobokassaGateway {
  private readonly logger = new Logger(RobokassaGateway.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  get available(): boolean {
    return Boolean(
      this.merchantLogin &&
      this.password1 &&
      this.password2 &&
      this.resultUrl &&
      this.successUrl &&
      this.failUrl,
    );
  }

  private get merchantLogin(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_MERCHANT_LOGIN')?.trim();
  }

  private get password1(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_PASSWORD1')?.trim();
  }

  private get password2(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_PASSWORD2')?.trim();
  }

  private get baseUrl(): string {
    return this.config
      .get<string>(
        'ROBO_KASSA_BASE_URL',
        'https://auth.robokassa.ru/Merchant/Index.aspx',
      )
      .trim();
  }

  private get resultUrl(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_RESULT_URL')?.trim();
  }

  private get successUrl(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_SUCCESS_URL')?.trim();
  }

  private get failUrl(): string | undefined {
    return this.config.get<string>('ROBO_KASSA_FAIL_URL')?.trim();
  }

  async checkout(order: PaymentOrder): Promise<string> {
    if (!this.available) {
      throw new ServiceUnavailableException(
        'Робокасса не настроена. Проверьте ROBO_KASSA_* переменные окружения.',
      );
    }

    const amount = this.formatAmount(order.amountKopecks);
    const currency = (order as { currency?: string }).currency ?? 'RUB';

    const planName =
      PLANS.find((plan) => plan.id === order.plan)?.name ?? String(order.plan);

    const periodLabel = String(order.period).toLowerCase().includes('year')
      ? 'годовая подписка'
      : 'месячная подписка';

    const user = await this.prisma.user.findUnique({
      where: { id: order.userId },
      select: { email: true },
    });

    const signatureString = `${this.merchantLogin}:${amount}:${order.orderId}:${this.password1}`;

    const signature = createHash('md5').update(signatureString).digest('hex');

    const params = new URLSearchParams({
      MerchantLogin: this.merchantLogin!,
      Amount: amount,
      InvId: String(order.orderId),
      SignatureValue: signature,
      OutSum: amount,
      Currency: currency,
      Description: `MyCOO · ${planName} · ${periodLabel}`,
      ResultURL: this.resultUrl!,
      SuccessURL: this.successUrl!,
      FailURL: this.failUrl!,
      Culture: 'ru-RU',
      Encoding: 'utf-8',
      IsTest: '1'
    });

    if (user?.email) {
      params.set('Email', user.email);
    }

    const url = `${this.baseUrl}?${params.toString()}`;

    this.logger.debug(`Robokassa checkout URL created for order ${order.id}`);

    return url;
  }

  private formatAmount(kopecks: number): string {
    const safe = Math.max(0, Math.round(kopecks));
    const rubles = Math.floor(safe / 100);
    const rest = safe % 100;

    return `${rubles}.${String(rest).padStart(2, '0')}`;
  }
}
