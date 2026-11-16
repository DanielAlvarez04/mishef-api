import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { WasteController } from './waste.controller';
import { WasteService } from './waste.service';

@Module({
  imports: [PrismaModule],
  controllers: [WasteController],
  providers: [WasteService, JwtAuthGuard, RolesGuard],
  exports: [WasteService],
})
export class WasteModule {}
