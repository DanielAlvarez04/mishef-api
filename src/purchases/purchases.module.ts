import { Module } from '@nestjs/common';

import { OpenAiCompatibleClient } from '../intel/providers/openai-compatible.client';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';
import { TicketExtractionWorker } from './ticket-extraction.worker';
import { TicketExtractionService } from './ticket-extraction.service';
import { TicketQueueService } from './ticket-queue.service';

@Module({
  controllers: [PurchasesController],
  providers: [
    PurchasesService,
    TicketExtractionService,
    TicketQueueService,
    TicketExtractionWorker,
    OpenAiCompatibleClient,
  ],
  exports: [TicketQueueService, TicketExtractionWorker],
})
export class PurchasesModule {}
