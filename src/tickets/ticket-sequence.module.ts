import { Module } from '@nestjs/common';

import { TicketSequenceService } from './ticket-sequence.service';

@Module({
  providers: [TicketSequenceService],
  exports: [TicketSequenceService],
})
export class TicketSequenceModule {}
