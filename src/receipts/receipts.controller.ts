import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ReceiptsService } from './receipts.service';

@ApiTags('receipts')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReceiptsController {
  constructor(private readonly receipts: ReceiptsService) {}

  @ApiOperation({
    summary: 'Plantillas de ticket por sucursal (superadmin)',
  })
  @Get('platform/receipts')
  @UseGuards(PlatformAdminGuard)
  list() {
    return this.receipts.list();
  }

  @ApiOperation({ summary: 'Guardar la plantilla global del ticket' })
  @Patch('platform/receipts/global')
  @UseGuards(PlatformAdminGuard)
  saveGlobal(
    @CurrentUser() user: JwtUser,
    @Body() body: { template?: unknown },
  ) {
    return this.receipts.saveGlobal(body?.template, user.sub);
  }

  @ApiOperation({
    summary: 'Aplicar la plantilla global a todas las sucursales',
  })
  @Post('platform/receipts/apply-global')
  @UseGuards(PlatformAdminGuard)
  applyGlobal() {
    return this.receipts.clearOverrides();
  }

  @ApiOperation({ summary: 'Guardar la plantilla de una sucursal' })
  @Patch('platform/branches/:id/receipt-template')
  @UseGuards(PlatformAdminGuard)
  save(@Param('id') branchId: string, @Body() body: { template?: unknown }) {
    return this.receipts.save(branchId, body?.template);
  }

  @ApiOperation({ summary: 'Vista previa de una plantilla de ticket' })
  @Post('platform/branches/:id/receipt-preview')
  @UseGuards(PlatformAdminGuard)
  preview(
    @Param('id') branchId: string,
    @Body() body: { template?: unknown; scenario?: unknown },
  ) {
    return this.receipts.preview(
      branchId,
      body?.template,
      undefined,
      scenarioOf(body?.scenario),
    );
  }

  @ApiOperation({ summary: 'Imprimir un ticket de prueba en la terminal' })
  @Post('platform/branches/:id/receipt-test')
  @UseGuards(PlatformAdminGuard)
  test(
    @Param('id') branchId: string,
    @Body() body: { template?: unknown; scenario?: unknown },
  ) {
    return this.receipts.testPrint(
      branchId,
      body?.template,
      undefined,
      scenarioOf(body?.scenario),
    );
  }

  /* --------------------------------------------------------------------- */
  /* Editor del negocio                                                     */
  /* --------------------------------------------------------------------- */

  @ApiOperation({ summary: 'Plantillas de ticket del negocio' })
  @Get('receipts/settings')
  @RequirePermissions('organization:manage')
  settings(@CurrentUser() user: JwtUser) {
    return this.receipts.listForOrganization(organizationId(user));
  }

  @ApiOperation({ summary: 'Guardar la plantilla de una sucursal del negocio' })
  @Patch('receipts/branches/:id/receipt-template')
  @RequirePermissions('organization:manage')
  saveForOrganization(
    @CurrentUser() user: JwtUser,
    @Param('id') branchId: string,
    @Body() body: { template?: unknown },
  ) {
    return this.receipts.save(
      branchId,
      body?.template,
      organizationId(user),
    );
  }

  @ApiOperation({ summary: 'Vista previa de la plantilla de una sucursal' })
  @Post('receipts/branches/:id/receipt-preview')
  @RequirePermissions('organization:manage')
  previewForOrganization(
    @CurrentUser() user: JwtUser,
    @Param('id') branchId: string,
    @Body() body: { template?: unknown; scenario?: unknown },
  ) {
    return this.receipts.preview(
      branchId,
      body?.template,
      organizationId(user),
      scenarioOf(body?.scenario),
    );
  }

  @ApiOperation({ summary: 'Imprimir una prueba de ticket del negocio' })
  @Post('receipts/branches/:id/receipt-test')
  @RequirePermissions('organization:manage')
  testForOrganization(
    @CurrentUser() user: JwtUser,
    @Param('id') branchId: string,
    @Body() body: { template?: unknown; scenario?: unknown },
  ) {
    return this.receipts.testPrint(
      branchId,
      body?.template,
      organizationId(user),
      scenarioOf(body?.scenario),
    );
  }
}

function scenarioOf(value: unknown): 'table' | 'paid' {
  return value === 'paid' ? 'paid' : 'table';
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene un negocio activo');
  }

  return user.organizationId;
}
