import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PurchaseStatus } from '@prisma/client';

import { JwtUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CreateTicketDto,
  PresignTicketDto,
  RejectPurchaseDto,
  ReviewPurchaseDto,
} from './dto/purchases.dto';
import { PurchasesService } from './purchases.service';

@ApiTags('purchases')
@Controller('purchases')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PurchasesController {
  constructor(private readonly purchases: PurchasesService) {}

  @ApiOperation({ summary: 'Firmar la subida de la foto de un ticket' })
  @RequirePermissions('purchases:manage')
  @Post('tickets/presign')
  presign(
    @CurrentUser() user: JwtUser,
    @Body() dto: PresignTicketDto,
  ) {
    return this.purchases.presignTicket(organizationId(user), dto);
  }

  @ApiOperation({ summary: 'Registrar un ticket para revisión' })
  @RequirePermissions('purchases:manage')
  @Post('tickets')
  createTicket(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateTicketDto,
  ) {
    return this.purchases.createTicket(
      organizationId(user),
      user.sub,
      branchId,
      dto,
    );
  }

  @ApiOperation({ summary: 'Extraer las líneas de un ticket con visión' })
  @RequirePermissions('purchases:manage')
  @Post(':id/extract')
  extract(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.purchases.extract(organizationId(user), user.sub, id);
  }

  @ApiOperation({ summary: 'Compras y tickets del negocio' })
  @RequirePermissions('purchases:read')
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('status') status?: string,
    @Query('supplierId') supplierId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
  ) {
    return this.purchases.list(organizationId(user), branchId, {
      status: parseStatus(status),
      supplierId,
      from,
      to,
      search,
    });
  }

  @ApiOperation({ summary: 'Métricas de auto-mapeo y estado de compras' })
  @RequirePermissions('purchases:read')
  @Get('metrics')
  metrics(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.purchases.metrics(organizationId(user), branchId);
  }

  @ApiOperation({ summary: 'Detalle de una compra' })
  @RequirePermissions('purchases:read')
  @Get(':id')
  get(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.purchases.get(organizationId(user), id);
  }

  @ApiOperation({ summary: 'Guardar la revisión de un ticket' })
  @RequirePermissions('purchases:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ReviewPurchaseDto,
  ) {
    return this.purchases.updateDraft(
      organizationId(user),
      user.sub,
      id,
      dto,
    );
  }

  @ApiOperation({ summary: 'Aprobar un ticket y crear movimientos de compra' })
  @RequirePermissions('purchases:review')
  @Post(':id/approve')
  approve(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.purchases.approve(organizationId(user), user.sub, id);
  }

  @ApiOperation({ summary: 'Rechazar un ticket' })
  @RequirePermissions('purchases:review')
  @Post(':id/reject')
  reject(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: RejectPurchaseDto,
  ) {
    return this.purchases.reject(organizationId(user), user.sub, id, dto);
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene organización');
  }

  return user.organizationId;
}

function parseStatus(value: string | undefined): PurchaseStatus | undefined {
  if (!value) return undefined;

  return Object.values(PurchaseStatus).includes(value as PurchaseStatus)
    ? (value as PurchaseStatus)
    : undefined;
}
