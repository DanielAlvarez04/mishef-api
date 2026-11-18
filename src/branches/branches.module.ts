import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingModule } from '../billing/billing.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { BranchesController } from './branches.controller';
import { BranchesService } from './branches.service';

@Module({
  imports: [PrismaModule, BillingModule],
  controllers: [BranchesController],
  providers: [BranchesService, JwtAuthGuard, RolesGuard],
  exports: [BranchesService],
})
export class BranchesModule {}
