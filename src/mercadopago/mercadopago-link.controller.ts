import {
  BadRequestException,
  Body,
  Controller,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreatePointChargeDto } from './dto/create-point-charge.dto';
import { MercadoPagoLinkService } from './mercadopago-link.service';

@ApiTags('payments')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class MercadoPagoLinkController {
  constructor(private readonly links: MercadoPagoLinkService) {}

  @ApiOperation({ summary: 'Crear un link de pago para una cuenta' })
  @RequirePermissions('payments:register')
  @Post('orders/:id/payments/link')
  create(
    @CurrentUser() user: JwtUser,
    @Param('id') orderId: string,
    @Body() dto: CreatePointChargeDto,
  ) {
    return this.links.createLink(
      organizationId(user),
      user.sub,
      orderId,
      dto,
    );
  }

  @ApiOperation({ summary: 'Conciliar un link de pago' })
  @RequirePermissions('payments:register')
  @Post('payments/:id/sync-link')
  sync(@CurrentUser() user: JwtUser, @Param('id') paymentId: string) {
    return this.links.syncPayment(organizationId(user), paymentId);
  }

  @ApiOperation({ summary: 'Cancelar un link de pago pendiente' })
  @RequirePermissions('payments:confirm')
  @Post('payments/:id/cancel-link')
  cancel(@CurrentUser() user: JwtUser, @Param('id') paymentId: string) {
    return this.links.cancelLink(
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
