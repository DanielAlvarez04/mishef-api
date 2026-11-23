import { Module } from '@nestjs/common';

import { OpenAiCompatibleClient } from '../providers/openai-compatible.client';
import { CatalogAiController } from './catalog-ai.controller';
import { CatalogAiService } from './catalog-ai.service';

@Module({
  controllers: [CatalogAiController],
  providers: [CatalogAiService, OpenAiCompatibleClient],
  exports: [CatalogAiService],
})
export class CatalogAiModule {}
