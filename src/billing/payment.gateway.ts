import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { PaymentOrder } from '../../generated/prisma/client.js';

@Injectable()
export class PaymentGateway {
  // Replace with Robokassa checkout creation. No credentials or test payments in the client.
  readonly available: boolean = false;

  async checkout(_order: PaymentOrder): Promise<string> {
    throw new ServiceUnavailableException(
      'Оплата пока недоступна. Попробуйте позже.',
    );
  }
}
