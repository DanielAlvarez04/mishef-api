import {
  BadRequestException,
  Controller,
  Get,
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
import { DashboardService } from './dashboard.service';

@ApiTags('dashboard')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /**
   * Panel principal.
   *
   * Cualquier rol con sesión puede verlo: el servicio decide si devuelve
   * importes según `reports:read` (ADMIN/CASHIER) y el resto recibe solo
   * métricas operativas (`money: false`).
   */
  @ApiOperation({ summary: 'Resumen del panel principal' })
  @Get('dashboard')
  overview(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('days') days?: string,
  ) {
    return this.dashboard.overview(
      user.organizationId,
      user.roles,
      parseDays(days),
      branchId,
    );
  }

  @ApiOperation({ summary: 'Benchmark anónimo contra negocios similares' })
  @RequirePermissions('reports:read')
  @Get('reports/benchmark')
  benchmark(
    @CurrentUser() user: JwtUser,
    @Query('days') days?: string,
  ) {
    return this.dashboard.benchmark(
      user.organizationId,
      days ? parseDays(days) : 30,
    );
  }

  @ApiOperation({ summary: 'Señales de fuga interna del periodo' })
  @RequirePermissions('reports:read')
  @Get('reports/leakage')
  leakage(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('days') days?: string,
  ) {
    return this.dashboard.leakageReport(
      user.organizationId,
      days ? parseDays(days) : 30,
      branchId,
    );
  }

  @ApiOperation({ summary: 'Reporte de ventas del periodo' })
  @RequirePermissions('reports:read')
  @Get('reports/sales')
  sales(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = parseRange(from, to);
    return this.dashboard.salesReport(
      user.organizationId,
      range.from,
      range.to,
      branchId,
    );
  }

  @ApiOperation({ summary: 'Reporte de inventario del periodo' })
  @RequirePermissions('reports:read:operations')
  @Get('reports/inventory')
  inventory(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = parseRange(from, to);
    return this.dashboard.inventoryReport(
      user.organizationId,
      range.from,
      range.to,
      branchId,
    );
  }

  @ApiOperation({ summary: 'Reporte de cocina del periodo' })
  @RequirePermissions('reports:read:operations')
  @Get('reports/kitchen')
  kitchen(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const range = parseRange(from, to);
    return this.dashboard.kitchenReport(
      user.organizationId,
      range.from,
      range.to,
      branchId,
    );
  }
}

function parseDays(value?: string): number {
  if (!value) return 7;

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new BadRequestException('El rango de días no es válido');
  }

  return parsed;
}

/** Periodo por defecto: los últimos 7 días, incluido hoy. */
function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 6 * 86400000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('El periodo no es válido');
  }

  if (start > end) {
    throw new BadRequestException('El inicio del periodo es posterior al fin');
  }

  // Si solo llega la fecha, el fin incluye el día completo.
  if (to && to.length === 10) {
    end.setHours(23, 59, 59, 999);
  }

  if (from && from.length === 10) {
    start.setHours(0, 0, 0, 0);
  }

  return { from: start, to: end };
}
