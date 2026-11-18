import { Module } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { DesignController } from './design.controller';
import { DesignService } from './design.service';

@Module({
  imports: [PrismaModule],
  controllers: [DesignController],
  providers: [DesignService, JwtAuthGuard, PlatformAdminGuard],
})
export class DesignModule {}
