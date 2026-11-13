import {
  Controller,
  Get,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { EMPTY, filter, map, type Observable } from 'rxjs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { JwtUser } from '../auth/auth.service';
import { RolesGuard } from '../common/guards/roles.guard';
import { OrdersService } from './orders.service';
import { OrdersEventsService, type OrderEvent } from './orders.events';

@ApiTags('kitchen')
@Controller('kitchen')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KitchenController {
  constructor(
    private readonly orders: OrdersService,
    private readonly events: OrdersEventsService,
  ) {}

  @ApiOperation({ summary: 'Rondas activas para el tablero de cocina' })
  @Get('rounds')
  rounds(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.orders.kitchenRounds(user.organizationId, branchId);
  }

  /**
   * Flujo SSE con los cambios de pedidos.
   *
   * El cliente abre un `EventSource` con credenciales y refresca el tablero
   * cuando llega un evento. Si el navegador no soporta SSE o la conexión se
   * cae, el tablero sigue actualizándose por sondeo periódico.
   *
   * El canal de eventos es único para todo el proceso, así que aquí se filtra
   * por la organización (y la sucursal activa) del usuario autenticado: sin
   * esto, la cocina de un negocio recibiría identificadores de pedidos de otro.
   * Los campos de filtrado no se envían al navegador.
   */
  @ApiOperation({ summary: 'Cambios de pedidos en tiempo real (SSE)' })
  @Sse('stream')
  stream(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ): Observable<MessageEvent> {
    if (!user.organizationId) return EMPTY;

    return this.events.stream.pipe(
      filter(
        (event: OrderEvent) =>
          event.organizationId === user.organizationId &&
          (!branchId || event.branchId === branchId),
      ),
      map(({ organizationId: _org, branchId: _branch, ...event }) => {
        return { data: event } as MessageEvent;
      }),
    );
  }
}
