import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { KitchenService } from '../kitchen/kitchen.service';
import { OrdersController } from './orders.controller';
import { KitchenController } from './kitchen.controller';
import { OrdersService } from './orders.service';
import { OrdersEventsService } from './orders.events';

@Module({
  imports: [AnalyticsModule],
  controllers: [OrdersController, KitchenController],
  providers: [OrdersService, OrdersEventsService, KitchenService],
  exports: [OrdersEventsService, KitchenService],
})
export class OrdersModule {}
