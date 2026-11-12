import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { validateEnv } from './config/env.validation';
import { PrismaModule } from './prisma/prisma.module';
import { MailModule } from './mail/mail.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { BranchesModule } from './branches/branches.module';
import { HealthModule } from './health/health.module';
import { CommonModule } from './common/common.module';
import { BranchContextInterceptor } from './branches/branch-context.interceptor';
import { CatalogModule } from './catalog/catalog.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrdersModule } from './orders/orders.module';
import { PaymentsModule } from './payments/payments.module';
import { CashModule } from './cash/cash.module';
import { PosModule } from './pos/pos.module';
import { MercadoPagoModule } from './mercadopago/mercadopago.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { UploadsModule } from './uploads/uploads.module';
import { OriginGuard } from './common/guards/origin.guard';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: 60_000,
        limit: 120,
      },
    ]),
    PrismaModule,
    CommonModule,
    MailModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    BranchesModule,
    CatalogModule,
    InventoryModule,
    OrdersModule,
    PaymentsModule,
    CashModule,
    PosModule,
    MercadoPagoModule,
    DashboardModule,
    UploadsModule,
    AnalyticsModule,
    HealthModule,
  ],
  controllers: [],
  providers: [
    {
      provide: APP_GUARD,
      useClass: OriginGuard,
    },
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: BranchContextInterceptor,
    },
  ],
})
export class AppModule {}
