import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { TicketSequenceModule } from '../tickets/ticket-sequence.module';
import { KitchenService } from '../kitchen/kitchen.service';
import { OrdersController } from './orders.controller';
import { OrderSplitsController } from './order-splits.controller';
import { KitchenController } from './kitchen.controller';
import { OrdersService } from './orders.service';
import { OrderSplitsService } from './order-splits.service';
import { OrdersEventsService } from './orders.events';

@Module({
  imports: [AnalyticsModule, TicketSequenceModule],
  controllers: [OrdersController, OrderSplitsController, KitchenController],
  providers: [OrdersService, OrderSplitsService, OrdersEventsService, KitchenService],
  exports: [OrdersEventsService, KitchenService, OrderSplitsService],
})
export class OrdersModule {}
