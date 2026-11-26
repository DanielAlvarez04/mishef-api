import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { RequireFeature } from '../features/require-feature.decorator';
import {
  CreateDiningTableDto,
  UpdateDiningTableDto,
} from './dto/dining-table.dto';
import { DiningTablesService } from './dining-tables.service';

@ApiTags('tables')
@Controller('tables')
@RequireFeature('pos')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DiningTablesController {
  constructor(private readonly tables: DiningTablesService) {}

  @ApiOperation({ summary: 'Mesas de la sucursal con sus cuentas abiertas' })
  @RequirePermissions('orders:draft')
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.tables.list(user.organizationId, branchId);
  }

  @ApiOperation({ summary: 'Crear una mesa' })
  @RequirePermissions('organization:manage')
  @Post()
  create(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateDiningTableDto,
  ) {
    return this.tables.create(user.organizationId, branchId, dto);
  }

  @ApiOperation({ summary: 'Editar una mesa' })
  @RequirePermissions('organization:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Param('id') id: string,
    @Body() dto: UpdateDiningTableDto,
  ) {
    return this.tables.update(user.organizationId, branchId, id, dto);
  }

  @ApiOperation({ summary: 'Eliminar una mesa sin cuentas asociadas' })
  @RequirePermissions('organization:manage')
  @Delete(':id')
  remove(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Param('id') id: string,
  ) {
    return this.tables.remove(user.organizationId, branchId, id);
  }
}
