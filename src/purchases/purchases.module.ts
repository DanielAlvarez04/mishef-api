import { Module } from '@nestjs/common';

import { OpenAiCompatibleClient } from '../intel/providers/openai-compatible.client';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';
import { TicketExtractionService } from './ticket-extraction.service';

@Module({
  controllers: [PurchasesController],
  providers: [
    PurchasesService,
    TicketExtractionService,
    OpenAiCompatibleClient,
  ],
})
export class PurchasesModule {}
