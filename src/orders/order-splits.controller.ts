import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateOrderSplitDto } from './dto/order-splits.dto';
import { OrderSplitsService } from './order-splits.service';

@ApiTags('orders')
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrderSplitsController {
  constructor(private readonly splits: OrderSplitsService) {}

  @ApiOperation({ summary: 'Partes de una cuenta dividida' })
  @Get(':id/splits')
  list(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.splits.list(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Dividir una cuenta (ADMIN, CASHIER o WAITER)' })
  @RequirePermissions('payments:register')
  @Post(':id/splits')
  create(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreateOrderSplitDto,
  ) {
    return this.splits.create(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Reemplazar la división activa en una sola llamada' })
  @RequirePermissions('payments:register')
  @Put(':id/splits')
  replace(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreateOrderSplitDto,
  ) {
    return this.splits.replace(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Cancelar la división de una cuenta' })
  @RequirePermissions('payments:register')
  @Delete(':id/splits')
  cancel(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.splits.cancel(user.organizationId, id);
  }
}
