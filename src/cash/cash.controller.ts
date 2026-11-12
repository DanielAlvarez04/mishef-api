import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CashService } from './cash.service';
import {
  CashMovementDto,
  ChargesReportQueryDto,
  CloseCashSessionDto,
  ListCashSessionsQueryDto,
  OpenCashSessionDto,
} from './dto/cash.dto';

@ApiTags('cash')
@Controller('cash')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CashController {
  constructor(private readonly cash: CashService) {}

  @ApiOperation({ summary: 'Turno de caja abierto de la sucursal activa' })
  @RequirePermissions('cash:read')
  @Get('sessions/current')
  current(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.cash.current(user.organizationId, branchId);
  }

  @ApiOperation({ summary: 'Historial de turnos de caja' })
  @RequirePermissions('cash:read')
  @Get('sessions')
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query() query: ListCashSessionsQueryDto,
  ) {
    return this.cash.list(user.organizationId, branchId, query);
  }

  @ApiOperation({ summary: 'Detalle de un turno con pagos y movimientos' })
  @RequirePermissions('cash:read')
  @Get('sessions/:id')
  detail(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.cash.detail(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Cobros por usuario para control de caja' })
  @RequirePermissions('reports:read')
  @Get('reports/charges')
  charges(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query() query: ChargesReportQueryDto,
  ) {
    return this.cash.chargesReport(
      user.organizationId,
      branchId,
      query.from,
      query.to,
    );
  }

  @ApiOperation({ summary: 'Abrir la caja de la sucursal' })
  @RequirePermissions('cash:manage')
  @Post('sessions')
  open(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: OpenCashSessionDto,
  ) {
    return this.cash.open(user.organizationId, branchId, user.sub, dto);
  }

  @ApiOperation({ summary: 'Cerrar la caja con conteo ciego' })
  @RequirePermissions('cash:manage')
  @Post('sessions/:id/close')
  close(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CloseCashSessionDto,
  ) {
    return this.cash.close(user.organizationId, id, user.sub, dto);
  }

  @ApiOperation({ summary: 'Registrar retiro, ingreso o gasto de efectivo' })
  @RequirePermissions('cash:manage')
  @Post('sessions/:id/movements')
  movement(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CashMovementDto,
  ) {
    return this.cash.addMovement(user.organizationId, id, user.sub, dto);
  }
}
