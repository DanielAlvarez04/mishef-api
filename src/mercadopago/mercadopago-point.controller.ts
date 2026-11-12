import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreatePointChargeDto } from './dto/create-point-charge.dto';
import { MercadoPagoPointService } from './mercadopago-point.service';

@ApiTags('payments')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class MercadoPagoPointController {
  constructor(private readonly point: MercadoPagoPointService) {}

  @ApiOperation({
    summary: 'Terminales disponibles para cobrar desde el POS',
  })
  @RequirePermissions('payments:register')
  @Get('mercadopago/point-config')
  config(@CurrentUser() user: JwtUser) {
    return this.point.getPointConfig(organizationId(user));
  }

  @ApiOperation({ summary: 'Enviar un cobro a la terminal Point' })
  @RequirePermissions('payments:register')
  @Post('orders/:id/payments/point')
  charge(
    @CurrentUser() user: JwtUser,
    @Param('id') orderId: string,
    @Body() dto: CreatePointChargeDto,
  ) {
    return this.point.createCharge(
      organizationId(user),
      user.sub,
      orderId,
      dto,
    );
  }

  @ApiOperation({ summary: 'Conciliar un cobro con Mercado Pago' })
  @RequirePermissions('payments:register')
  @Post('payments/:id/sync')
  sync(@CurrentUser() user: JwtUser, @Param('id') paymentId: string) {
    return this.point.syncPayment(organizationId(user), paymentId);
  }

  @ApiOperation({ summary: 'Cancelar un cobro pendiente en la terminal' })
  @RequirePermissions('payments:confirm')
  @Post('payments/:id/cancel-point')
  cancel(@CurrentUser() user: JwtUser, @Param('id') paymentId: string) {
    return this.point.cancelCharge(
      organizationId(user),
      { id: user.sub, roles: user.roles },
      paymentId,
    );
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene un negocio activo');
  }

  return user.organizationId;
}
