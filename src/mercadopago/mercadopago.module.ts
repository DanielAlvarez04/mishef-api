import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments/payments.module';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoController } from './mercadopago.controller';
import { MercadoPagoLinkController } from './mercadopago-link.controller';
import { MercadoPagoLinkService } from './mercadopago-link.service';
import { MercadoPagoPointController } from './mercadopago-point.controller';
import { MercadoPagoPointService } from './mercadopago-point.service';
import { PointReceiptPrintService } from './point-receipt-print.service';
import { MercadoPagoRefundHandler } from './mercadopago-refund.handler';
import { MercadoPagoService } from './mercadopago.service';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import { MercadoPagoWebhookController } from './mercadopago-webhook.controller';
import { MercadoPagoWebhookService } from './mercadopago-webhook.service';
import { TokenCipher } from './token-cipher';

@Module({
  imports: [PaymentsModule],
  controllers: [
    MercadoPagoController,
    MercadoPagoPointController,
    MercadoPagoLinkController,
    MercadoPagoWebhookController,
  ],
  providers: [
    TokenCipher,
    MercadoPagoClient,
    MercadoPagoTokenService,
    MercadoPagoService,
    MercadoPagoPointService,
    PointReceiptPrintService,
    MercadoPagoLinkService,
    MercadoPagoRefundHandler,
    MercadoPagoWebhookService,
  ],
  exports: [
    TokenCipher,
    MercadoPagoClient,
    MercadoPagoTokenService,
    MercadoPagoService,
    MercadoPagoPointService,
    PointReceiptPrintService,
    MercadoPagoLinkService,
    MercadoPagoWebhookService,
  ],
})
export class MercadoPagoModule {}
