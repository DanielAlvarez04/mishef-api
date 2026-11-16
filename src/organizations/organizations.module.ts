import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { OrganizationsController } from './organizations.controller';
import { PublicTenantController } from './public-tenant.controller';
import { OrganizationsService } from './organizations.service';
import { CloudflareHostnamesService } from './cloudflare-hostnames.service';

@Module({
  imports: [PrismaModule],
  controllers: [OrganizationsController, PublicTenantController],
  providers: [OrganizationsService, CloudflareHostnamesService, JwtAuthGuard, RolesGuard],
  exports: [OrganizationsService],
})
export class OrganizationsModule {}
