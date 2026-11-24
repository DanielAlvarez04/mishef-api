import { Module } from '@nestjs/common';

import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [MercadoPagoModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService],
})
export class ReceiptsModule {}
