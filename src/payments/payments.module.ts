import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { ProviderPaymentRegistry } from './provider-payment.registry';

@Module({
  imports: [OrdersModule, AnalyticsModule],
  controllers: [PaymentsController],
  providers: [PaymentsService, ProviderPaymentRegistry],
  exports: [PaymentsService, ProviderPaymentRegistry],
})
export class PaymentsModule {}
