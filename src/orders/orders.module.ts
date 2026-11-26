import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { TicketSequenceModule } from '../tickets/ticket-sequence.module';
import { KitchenService } from '../kitchen/kitchen.service';
import { KitchenConfigController } from '../kitchen/kitchen-config.controller';
import { KitchenConfigService } from '../kitchen/kitchen-config.service';
import { KitchenTicketsController } from '../kitchen/kitchen-tickets.controller';
import { KitchenTicketingService } from '../kitchen/kitchen-ticketing.service';
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
    KitchenTicketsController,
  ],
  providers: [
    OrdersService,
    OrderSplitsService,
    OrdersEventsService,
    KitchenService,
    KitchenConfigService,
    KitchenTicketingService,
  ],
  exports: [OrdersEventsService, KitchenService, OrderSplitsService],
})
export class OrdersModule {}
