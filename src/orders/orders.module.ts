import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { TicketSequenceModule } from '../tickets/ticket-sequence.module';
import { KitchenService } from '../kitchen/kitchen.service';
import { KitchenConfigController } from '../kitchen/kitchen-config.controller';
import { KitchenConfigService } from '../kitchen/kitchen-config.service';
import { OrdersController } from './orders.controller';
import { OrderSplitsController } from './order-splits.controller';
import { KitchenController } from './kitchen.controller';
import { OrdersService } from './orders.service';
import { OrderSplitsService } from './order-splits.service';
import { OrdersEventsService } from './orders.events';

@Module({
  imports: [AnalyticsModule, TicketSequenceModule],
  controllers: [
    OrdersController,
    OrderSplitsController,
    KitchenController,
    KitchenConfigController,
  ],
  providers: [
    OrdersService,
    OrderSplitsService,
    OrdersEventsService,
    KitchenService,
    KitchenConfigService,
  ],
  exports: [OrdersEventsService, KitchenService, OrderSplitsService],
})
export class OrdersModule {}
