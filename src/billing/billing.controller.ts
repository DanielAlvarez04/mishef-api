import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { BillingInterval } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { BillingService } from './billing.service';
import { ChangePlanDto, SubscribeDto } from './dto/billing.dto';
import { requireOrganization } from './platform-admin.guard';

@ApiTags('billing')
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  @ApiOperation({ summary: 'Planes disponibles para el negocio' })
  @RequirePermissions('organization:manage')
  @Get('plans')
  plans() {
    return this.billing.listPlans();
  }

  @ApiOperation({ summary: 'Suscripción actual y consumo del negocio' })
  @RequirePermissions('organization:manage')
  @Get('subscription')
  subscription(@CurrentUser() user: JwtUser) {
    return this.billing.getSubscription(requireOrganization(user));
  }

  @ApiOperation({ summary: 'Cotización de cambio de plan con prorrateo' })
  @RequirePermissions('organization:manage')
  @Get('quote')
  quote(
    @CurrentUser() user: JwtUser,
    @Query('planCode') planCode?: string,
    @Query('interval') interval?: string,
  ) {
    if (!planCode) {
      throw new BadRequestException('Indica el plan');
    }

    if (
      interval !== BillingInterval.MONTH &&
      interval !== BillingInterval.YEAR
    ) {
      throw new BadRequestException('El intervalo debe ser MONTH o YEAR');
    }

    return this.billing.getUpgradeQuote(
      requireOrganization(user),
      planCode,
      interval,
    );
  }

  @ApiOperation({ summary: 'Contratar un plan con cobro recurrente' })
  @RequirePermissions('organization:manage')
  @HttpCode(201)
  @Post('subscribe')
  subscribe(@CurrentUser() user: JwtUser, @Body() dto: SubscribeDto) {
    return this.billing.subscribe(requireOrganization(user), dto);
  }

  @ApiOperation({ summary: 'Cambiar a un plan superior con prorrateo' })
  @RequirePermissions('organization:manage')
  @HttpCode(201)
  @Post('change-plan')
  changePlan(@CurrentUser() user: JwtUser, @Body() dto: ChangePlanDto) {
    return this.billing.changePlan(requireOrganization(user), dto);
  }

  @ApiOperation({ summary: 'Cancelar la renovación automática' })
  @RequirePermissions('organization:manage')
  @HttpCode(200)
  @Post('cancel')
  cancel(@CurrentUser() user: JwtUser) {
    return this.billing.cancel(requireOrganization(user));
  }

  @ApiOperation({ summary: 'Pausar la suscripción' })
  @RequirePermissions('organization:manage')
  @HttpCode(200)
  @Post('pause')
  pause(@CurrentUser() user: JwtUser) {
    return this.billing.pause(requireOrganization(user));
  }

  @ApiOperation({ summary: 'Reactivar la suscripción' })
  @RequirePermissions('organization:manage')
  @HttpCode(200)
  @Post('resume')
  resume(@CurrentUser() user: JwtUser) {
    return this.billing.resume(requireOrganization(user));
  }

  @ApiOperation({ summary: 'Sincronizar con Mercado Pago' })
  @RequirePermissions('organization:manage')
  @HttpCode(200)
  @Post('sync')
  sync(@CurrentUser() user: JwtUser) {
    return this.billing.sync(requireOrganization(user));
  }

  @ApiOperation({ summary: 'Pagos de la suscripción' })
  @RequirePermissions('organization:manage')
  @Get('payments')
  payments(@CurrentUser() user: JwtUser) {
    return this.billing.listPayments(requireOrganization(user));
  }
}
