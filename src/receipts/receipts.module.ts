import { Module } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { MercadoPagoModule } from '../mercadopago/mercadopago.module';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [MercadoPagoModule],
  controllers: [ReceiptsController],
  providers: [ReceiptsService, JwtAuthGuard, PlatformAdminGuard, RolesGuard],
})
export class ReceiptsModule {}
