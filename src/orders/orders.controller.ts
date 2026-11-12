import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrderStatus } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { OrdersService } from './orders.service';
import {
  CancelOrderDto,
  CreateOrderDto,
  OrderGuestDto,
  SendRoundDto,
  TransitionRoundDto,
} from './dto/orders.dto';

@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @ApiOperation({ summary: 'Listar cuentas (pedidos) de la organización' })
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.orders.list(
      user.organizationId,
      {
        status: parseStatus(status),
        limit: parseInteger(limit, 50),
        offset: parseInteger(offset, 0),
      },
      branchId,
    );
  }

  @ApiOperation({ summary: 'Abrir una cuenta (borrador)' })
  @RequirePermissions('orders:draft')
  @Post()
  create(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateOrderDto,
  ) {
    return this.orders.create(user.organizationId, user.sub, dto, branchId);
  }

  @ApiOperation({ summary: 'Detalle de una cuenta con rondas e historial' })
  @Get(':id')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.orders.get(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Enviar una ronda (comanda) a cocina' })
  @RequirePermissions('orders:send')
  @Post(':id/rounds')
  sendRound(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: SendRoundDto,
  ) {
    return this.orders.sendRound(user.organizationId, user.sub, id, dto);
  }

  @ApiOperation({
    summary: 'Cambiar el estado de una ronda (inicia consumo de inventario)',
  })
  @RequirePermissions('kitchen:transition')
  @Patch(':id/rounds/:roundId/status')
  transition(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('roundId') roundId: string,
    @Body() dto: TransitionRoundDto,
  ) {
    return this.orders.transitionRound(
      user.organizationId,
      user.sub,
      id,
      roundId,
      dto,
    );
  }

  @ApiOperation({ summary: 'Añadir una persona a la cuenta' })
  @RequirePermissions('orders:draft')
  @Post(':id/guests')
  addGuest(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: OrderGuestDto,
  ) {
    return this.orders.addGuest(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Editar una persona de la cuenta' })
  @RequirePermissions('orders:draft')
  @Patch(':id/guests/:guestId')
  renameGuest(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('guestId') guestId: string,
    @Body() dto: OrderGuestDto,
  ) {
    return this.orders.renameGuest(user.organizationId, id, guestId, dto);
  }

  @ApiOperation({ summary: 'Quitar una persona de la cuenta' })
  @RequirePermissions('orders:draft')
  @Delete(':id/guests/:guestId')
  removeGuest(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('guestId') guestId: string,
  ) {
    return this.orders.removeGuest(user.organizationId, id, guestId);
  }

  @ApiOperation({ summary: 'Cancelar una cuenta abierta' })
  @RequirePermissions('orders:draft')
  @Patch(':id/cancel')
  cancel(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CancelOrderDto,
  ) {
    return this.orders.cancelOrder(user.organizationId, user.sub, id, dto);
  }
}

function parseStatus(value?: string): OrderStatus | undefined {
  if (!value) {
    return undefined;
  }

  if (!Object.values(OrderStatus).includes(value as OrderStatus)) {
    throw new BadRequestException('Estado de pedido inválido');
  }

  return value as OrderStatus;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new BadRequestException('Se esperaba un número entero');
  }

  return parsed;
}
