import { Module } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { FiscalController } from './fiscal.controller';
import { FiscalService } from './fiscal.service';

@Module({
  imports: [PrismaModule],
  controllers: [FiscalController],
  providers: [FiscalService, JwtAuthGuard, RolesGuard],
})
export class FiscalModule {}
