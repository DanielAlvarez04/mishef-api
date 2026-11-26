import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { PosController } from './pos.controller';
import { PosDraftsService } from './pos-drafts.service';
import { PosService } from './pos.service';

@Module({
  imports: [AuthModule],
  controllers: [PosController],
  providers: [PosService, PosDraftsService],
  exports: [PosService, PosDraftsService],
})
export class PosModule {}
