import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';

import { MercadoPagoWebhookService } from './mercadopago-webhook.service';

/**
 * Webhook público de Mercado Pago.
 *
 * No lleva `JwtAuthGuard` ni `OriginGuard` (MP no envía cookies) y se salta el
 * rate limit global: la autenticación es la firma HMAC de la cabecera.
 */
@ApiTags('webhooks')
@Controller('webhooks')
export class MercadoPagoWebhookController {
  constructor(private readonly webhook: MercadoPagoWebhookService) {}

  @ApiOperation({ summary: 'Notificaciones de orders de Mercado Pago' })
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @Post('mercadopago')
  handle(
    @Req() req: Request,
    @Headers('x-signature') signature?: string,
    @Headers('x-request-id') requestId?: string,
    @Query('data.id') dataId?: string,
    @Query('data_id') dataIdAlt?: string,
    @Query('type') type?: string,
  ) {
    return this.webhook.handle({
      body: req.body as unknown,
      headers: { signature, requestId },
      query: { dataId, dataIdAlt, type },
    });
  }
}
