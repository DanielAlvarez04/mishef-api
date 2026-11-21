import { Module } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { VerifiedEmailGuard } from '../auth/guards/verified-email.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { BillingClient } from './billing.client';
import { BillingController } from './billing.controller';
import { BillingPlatformController } from './billing-platform.controller';
import { BillingService } from './billing.service';
import { BillingWebhookController } from './billing-webhook.controller';
import { PlatformAdminGuard } from './platform-admin.guard';

@Module({
  imports: [PrismaModule],
  controllers: [
    BillingController,
    BillingPlatformController,
    BillingWebhookController,
  ],
  providers: [
    BillingService,
    BillingClient,
    PlatformAdminGuard,
    JwtAuthGuard,
    RolesGuard,
    VerifiedEmailGuard,
  ],
  exports: [BillingService],
})
export class BillingModule {}
