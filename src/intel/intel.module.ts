import { Module } from '@nestjs/common';

import { CatalogModule } from '../catalog/catalog.module';
import { DashboardModule } from '../dashboard/dashboard.module';
import { InventoryModule } from '../inventory/inventory.module';
import { IntelController } from './intel.controller';
import { IntelService } from './intel.service';
import { OpenAiCompatibleClient } from './providers/openai-compatible.client';
import { CatalogTools } from './tools/catalog.tools';
import { InventoryTools } from './tools/inventory.tools';
import { SalesTools } from './tools/sales.tools';
import { IntelToolRegistry } from './tools/tool.registry';

@Module({
  imports: [DashboardModule, CatalogModule, InventoryModule],
  controllers: [IntelController],
  providers: [
    IntelService,
    OpenAiCompatibleClient,
    IntelToolRegistry,
    SalesTools,
    CatalogTools,
    InventoryTools,
  ],
})
export class IntelModule {}
