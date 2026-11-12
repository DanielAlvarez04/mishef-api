import { Module } from '@nestjs/common';

import { PaymentsModule } from '../payments/payments.module';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoController } from './mercadopago.controller';
import { MercadoPagoPointController } from './mercadopago-point.controller';
import { MercadoPagoPointService } from './mercadopago-point.service';
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
    MercadoPagoWebhookController,
  ],
  providers: [
    TokenCipher,
    MercadoPagoClient,
    MercadoPagoTokenService,
    MercadoPagoService,
    MercadoPagoPointService,
    MercadoPagoWebhookService,
  ],
  exports: [
    TokenCipher,
    MercadoPagoClient,
    MercadoPagoTokenService,
    MercadoPagoService,
    MercadoPagoPointService,
    MercadoPagoWebhookService,
  ],
})
export class MercadoPagoModule {}
