import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { rolesHavePermission } from '../common/permissions';
import { PaymentsService } from './payments.service';
import { RequireFeature } from '../features/require-feature.decorator';
import {
  CreatePaymentDto,
  ListPaymentsQueryDto,
  ReconcilePaymentDto,
  RegisterOfflineCardPaymentDto,
  VoidPaymentDto,
} from './dto/payments.dto';

@ApiTags('payments')
@Controller()
@RequireFeature('pos.payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @ApiOperation({ summary: 'Caja: listado de pagos con totales' })
  @RequirePermissions('reports:read')
  @Get('payments')
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query() query: ListPaymentsQueryDto,
  ) {
    return this.payments.list(
      user.organizationId,
      {
        from: parseDate(query.from, 'desde'),
        to: parseDate(query.to, 'hasta'),
        method: query.method,
        status: query.status,
        review: query.review,
        limit: query.limit,
        offset: query.offset,
      },
      branchId,
    );
  }

  @ApiOperation({ summary: 'Registrar un pago (queda pendiente)' })
  @RequirePermissions('payments:register')
  @Post('orders/:id/payments')
  register(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreatePaymentDto,
  ) {
    if (
      dto.confirm &&
      !rolesHavePermission(user.roles, 'payments:confirm')
    ) {
      throw new ForbiddenException('No puedes confirmar pagos');
    }

    return this.payments.register(user.organizationId, user.sub, id, dto, {
      confirm: Boolean(dto.confirm),
    });
  }

  @ApiOperation({
    summary: 'Registrar un cobro con tarjeta capturado sin conexión',
  })
  @RequirePermissions('payments:register')
  @Post('orders/:id/payments/offline-card')
  registerOfflineCard(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: RegisterOfflineCardPaymentDto,
  ) {
    return this.payments.registerOfflineCard(
      user.organizationId,
      user.sub,
      id,
      dto,
    );
  }

  @ApiOperation({ summary: 'Conciliar un cobro offline pendiente' })
  @RequirePermissions('payments:confirm')
  @Post('payments/:id/reconcile')
  reconcile(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ReconcilePaymentDto,
  ) {
    return this.payments.reconcile(
      user.organizationId,
      { id: user.sub, roles: user.roles },
      id,
      dto,
    );
  }

  @ApiOperation({ summary: 'Confirmar un pago pendiente' })
  @RequirePermissions('payments:confirm')
  @Post('payments/:id/confirm')
  confirm(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.payments.confirm(user.organizationId, user.sub, id);
  }

  @ApiOperation({ summary: 'Anular un pago pendiente o reembolsar uno confirmado' })
  @RequirePermissions('payments:register')
  @Post('payments/:id/void')
  voidPayment(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: VoidPaymentDto,
  ) {
    return this.payments.voidPayment(
      user.organizationId,
      { id: user.sub, roles: user.roles },
      id,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Cerrar una cuenta pagada y sin rondas pendientes de entrega',
  })
  @RequirePermissions('payments:confirm')
  @Post('orders/:id/close')
  close(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.payments.closeOrder(user.organizationId, user.sub, id);
  }
}

function parseDate(value: string | undefined, label: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`Fecha ${label} inválida`);
  }

  return date;
}
