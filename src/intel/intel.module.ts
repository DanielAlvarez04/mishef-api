import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { InventoryModule } from '../inventory/inventory.module';
import { WasteModule } from '../waste/waste.module';
import { AnomaliesModule } from './anomalies/anomalies.module';
import { CatalogAiModule } from './catalog-ai/catalog-ai.module';
import { IntelDigestService } from './digest/intel-digest.service';
import { ForecastModule } from './forecast/forecast.module';
import { IntelController } from './intel.controller';
import { IntelService } from './intel.service';
import { OpenAiCompatibleClient } from './providers/openai-compatible.client';
import { AnomaliesTools } from './tools/anomalies.tools';
import { CatalogTools } from './tools/catalog.tools';
import { ForecastTools } from './tools/forecast.tools';
import { InventoryTools } from './tools/inventory.tools';
import { KitchenTools } from './tools/kitchen.tools';
import { SalesTools } from './tools/sales.tools';
import { IntelToolRegistry } from './tools/tool.registry';

@Module({
  imports: [
    DashboardModule,
    CatalogModule,
    InventoryModule,
    WasteModule,
    ForecastModule,
    CatalogAiModule,
    AnomaliesModule,
  ],
  controllers: [IntelController],
  providers: [
    IntelService,
    OpenAiCompatibleClient,
    IntelToolRegistry,
    SalesTools,
    CatalogTools,
    InventoryTools,
    KitchenTools,
    ForecastTools,
    AnomaliesTools,
    IntelDigestService,
  ],
  exports: [IntelDigestService],
})
export class IntelModule {}
