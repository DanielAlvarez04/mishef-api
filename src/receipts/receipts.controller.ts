import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { ReceiptsService } from './receipts.service';

@ApiTags('receipts')
@Controller()
@UseGuards(JwtAuthGuard)
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

  @ApiOperation({ summary: 'Guardar la plantilla de una sucursal' })
  @Patch('platform/branches/:id/receipt-template')
  @UseGuards(PlatformAdminGuard)
  save(@Param('id') branchId: string, @Body() body: { template?: unknown }) {
    return this.receipts.save(branchId, body?.template);
  }

  @ApiOperation({ summary: 'Vista previa de una plantilla de ticket' })
  @Post('platform/branches/:id/receipt-preview')
  @UseGuards(PlatformAdminGuard)
  preview(@Param('id') branchId: string, @Body() body: { template?: unknown }) {
    return this.receipts.preview(branchId, body?.template);
  }

  @ApiOperation({ summary: 'Imprimir un ticket de prueba en la terminal' })
  @Post('platform/branches/:id/receipt-test')
  @UseGuards(PlatformAdminGuard)
  test(@Param('id') branchId: string, @Body() body: { template?: unknown }) {
    return this.receipts.testPrint(branchId, body?.template);
  }
}
