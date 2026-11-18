import { Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

import { BillingService } from './billing.service';

@ApiTags('billing-webhooks')
@Controller('webhooks')
export class BillingWebhookController {
  constructor(private readonly billing: BillingService) {}

  @ApiOperation({ summary: 'Notificaciones de suscripciones de Mercado Pago' })
  @HttpCode(200)
  @Post('mercadopago-billing')
  handle(@Req() request: Request) {
    return this.billing.handleWebhook({
      body: request.body,
      headers: {
        signature: request.headers['x-signature'],
        requestId: request.headers['x-request-id'],
      },
      query: {
        dataId: request.query['data.id'] as string | string[] | undefined,
        dataIdAlt: request.query.data_id as string | string[] | undefined,
        type: request.query.type as string | string[] | undefined,
      },
    });
  }
}
