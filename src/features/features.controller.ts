import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import {
  DEFAULT_FEATURES,
  FEATURE_CATALOG,
} from '../common/features';
import { FeaturesService } from './features.service';

@ApiTags('features')
@Controller()
@UseGuards(JwtAuthGuard)
export class FeaturesController {
  constructor(private readonly features: FeaturesService) {}

  @ApiOperation({ summary: 'Funciones activas de la organización' })
  @Get('features')
  getForOrganization(@CurrentUser() user: JwtUser) {
    if (!user.organizationId) return DEFAULT_FEATURES;

    return this.features.getEffective(user.organizationId);
  }

  @ApiOperation({ summary: 'Matriz de funciones para el superadmin' })
  @Get('platform/features')
  @UseGuards(PlatformAdminGuard)
  async listForPlatform() {
    return {
      defaults: DEFAULT_FEATURES,
      catalog: FEATURE_CATALOG,
      organizations: await this.features.listOrganizations(),
    };
  }

  @ApiOperation({ summary: 'Guardar overrides de funciones de un negocio' })
  @Patch('platform/organizations/:id/features')
  @UseGuards(PlatformAdminGuard)
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') organizationId: string,
    @Body() body: { overrides?: unknown },
  ) {
    return this.features.setOverrides(
      organizationId,
      body.overrides ?? {},
      user.sub,
    );
  }
}
