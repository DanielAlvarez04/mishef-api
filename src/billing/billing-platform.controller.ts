import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { BillingService } from './billing.service';
import {
  CreatePlanDto,
  ManualSubscriptionDto,
  PlatformOrganizationsQueryDto,
  UpdatePlanDto,
} from './dto/billing.dto';
import { PlatformAdminGuard } from './platform-admin.guard';

@ApiTags('platform-billing')
@Controller('platform')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class BillingPlatformController {
  constructor(private readonly billing: BillingService) {}

  @ApiOperation({ summary: 'Planes (incluye ocultos)' })
  @Get('plans')
  plans() {
    return this.billing.listPlans(true);
  }

  @ApiOperation({ summary: 'Crear plan' })
  @Post('plans')
  createPlan(@CurrentUser() user: JwtUser, @Body() dto: CreatePlanDto) {
    return this.billing.createPlan(dto, user.sub);
  }

  @ApiOperation({ summary: 'Editar plan' })
  @Patch('plans/:id')
  updatePlan(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.billing.updatePlan(id, dto, user.sub);
  }

  @ApiOperation({ summary: 'Negocios y suscripciones' })
  @Get('organizations')
  organizations(@Query() query: PlatformOrganizationsQueryDto) {
    return this.billing.listPlatformOrganizations(query);
  }

  @ApiOperation({ summary: 'Ajustar manualmente una suscripción' })
  @Patch('organizations/:id/subscription')
  updateSubscription(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ManualSubscriptionDto,
  ) {
    return this.billing.updateOrganizationSubscription(id, dto, user.sub);
  }

  @ApiOperation({ summary: 'Pagos de suscripciones' })
  @Get('payments')
  payments() {
    return this.billing.listPlatformPayments();
  }
}
