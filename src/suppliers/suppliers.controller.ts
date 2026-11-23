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

import { JwtUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CreateSupplierDto,
  CreateSupplierProductDto,
  UpdateSupplierDto,
} from './dto/supplier.dto';
import { SuppliersService } from './suppliers.service';

@ApiTags('suppliers')
@Controller('suppliers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @ApiOperation({ summary: 'Proveedores del negocio' })
  @RequirePermissions('purchases:read')
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.suppliers.list(
      organizationId(user),
      search,
      includeInactive === 'true' || includeInactive === '1',
    );
  }

  @ApiOperation({ summary: 'Crear proveedor' })
  @RequirePermissions('suppliers:manage')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateSupplierDto) {
    return this.suppliers.create(organizationId(user), user.sub, dto);
  }

  @ApiOperation({ summary: 'Editar proveedor' })
  @RequirePermissions('suppliers:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateSupplierDto,
  ) {
    return this.suppliers.update(organizationId(user), user.sub, id, dto);
  }

  @ApiOperation({ summary: 'Desactivar proveedor' })
  @RequirePermissions('suppliers:manage')
  @Delete(':id')
  deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.suppliers.deactivate(organizationId(user), user.sub, id);
  }

  @ApiOperation({ summary: 'Productos mapeados del proveedor' })
  @RequirePermissions('purchases:read')
  @Get(':id/products')
  listProducts(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.suppliers.listProducts(organizationId(user), id);
  }

  @ApiOperation({ summary: 'Mapear producto del proveedor a un ingrediente' })
  @RequirePermissions('suppliers:manage')
  @Post(':id/products')
  createProduct(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreateSupplierProductDto,
  ) {
    return this.suppliers.createProduct(
      organizationId(user),
      user.sub,
      id,
      dto,
    );
  }

  @ApiOperation({ summary: 'Eliminar mapeo de producto' })
  @RequirePermissions('suppliers:manage')
  @Delete(':id/products/:productId')
  deleteProduct(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('productId') productId: string,
  ) {
    return this.suppliers.deleteProduct(
      organizationId(user),
      user.sub,
      id,
      productId,
    );
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene organización');
  }

  return user.organizationId;
}
