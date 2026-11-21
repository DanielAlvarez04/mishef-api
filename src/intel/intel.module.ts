import { Module } from '@nestjs/common';
import { IntelController } from './intel.controller';
import { IntelService } from './intel.service';
import { OpenAiCompatibleClient } from './providers/openai-compatible.client';

@Module({
  controllers: [IntelController],
  providers: [IntelService, OpenAiCompatibleClient],
})
export class IntelModule {}
