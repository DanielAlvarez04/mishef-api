import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { TransitionKitchenTicketDto } from './dto/kitchen-ticket.dto';
import { OrdersService } from '../orders/orders.service';

@ApiTags('kitchen-tickets')
@Controller('kitchen')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KitchenTicketsController {
  constructor(private readonly orders: OrdersService) {}

  @ApiOperation({ summary: 'Tablero de tickets por estación' })
  @RequirePermissions('kitchen:read')
  @Get('tickets')
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.orders.kitchenTickets(user, branchId);
  }

  @ApiOperation({ summary: 'Cambiar el estado de un ticket de estación' })
  @RequirePermissions('kitchen:read')
  @Patch('tickets/:id/status')
  transition(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: TransitionKitchenTicketDto,
  ) {
    return this.orders.transitionKitchenTicket(user, id, dto);
  }
}
