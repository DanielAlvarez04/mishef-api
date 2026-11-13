import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InventoryMovementType } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { InventoryService } from './inventory.service';
import {
  CreateAdjustmentDto,
  CreateEquivalenceDto,
  CreateIngredientDto,
  CreateIngredientsBulkDto,
  DeleteIngredientsDto,
  SyncCoreItemsDto,
  UpdateCoreIngredientCategoriesDto,
  UpdateIngredientDto,
} from './dto/inventory.dto';

@ApiTags('inventory')
@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // --------------------------------------------------------------------------
  // Ingredientes
  // --------------------------------------------------------------------------

  @ApiOperation({ summary: 'Listar ingredientes con su stock' })
  @Get('ingredients')
  listIngredients(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('lowStockOnly') lowStockOnly?: string,
    @Query('includeBranchStocks') includeBranchStocks?: string,
  ) {
    return this.inventory.listIngredients(
      user.organizationId,
      {
        search,
        includeInactive: includeInactive === 'true',
        lowStockOnly: lowStockOnly === 'true',
        // Modo Global: el resumen KPI necesita el stock de cada sucursal.
        includeBranchStocks: includeBranchStocks === 'true',
      },
      branchId,
    );
  }

  @ApiOperation({ summary: 'Crear ingrediente' })
  @RequirePermissions('inventory:manage')
  @Post('ingredients')
  createIngredient(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateIngredientDto,
  ) {
    return this.inventory.createIngredient(
      user.organizationId,
      user.sub,
      dto,
      branchId,
    );
  }

  @ApiOperation({ summary: 'Crear varios ingredientes a la vez' })
  @RequirePermissions('inventory:manage')
  @Post('ingredients/bulk')
  createIngredients(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateIngredientsBulkDto,
  ) {
    return this.inventory.createIngredients(
      user.organizationId,
      user.sub,
      dto.ingredients,
      branchId,
    );
  }

  @ApiOperation({ summary: 'Importar ingredientes desde CSV' })
  @RequirePermissions('inventory:manage')
  @Post('ingredients/import-csv')
  async importCsv(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() body: { csv: string; mode?: string },
  ) {
    return this.inventory.importIngredientsFromCsv(
      user.organizationId,
      user.sub,
      body.csv,
      branchId,
      body.mode,
    );
  }

  @ApiOperation({ summary: 'Editar ingrediente (nombre, unidad mínima, stock mínimo)' })
  @RequirePermissions('inventory:manage')
  @Patch('ingredients/:id')
  updateIngredient(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateIngredientDto,
  ) {
    return this.inventory.updateIngredient(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Sincronizar insumos core con el inventario' })
  @RequirePermissions('inventory:manage')
  @HttpCode(HttpStatus.OK)
  @Post('ingredients/sync-core')
  syncCoreItems(
    @CurrentUser() user: JwtUser,
    @Body() dto: SyncCoreItemsDto,
  ) {
    return this.inventory.syncCoreItems(
      user.organizationId,
      user.sub,
      dto.items,
      dto.removeNames,
      dto.removeItems ?? [],
    );
  }

  @ApiOperation({ summary: 'Eliminar insumos permanentemente (hard delete)' })
  @RequirePermissions('inventory:manage')
  @HttpCode(HttpStatus.OK)
  @Post('ingredients/bulk-delete')
  deleteIngredients(
    @CurrentUser() user: JwtUser,
    @Body() dto: DeleteIngredientsDto,
  ) {
    return this.inventory.deleteIngredients(
      user.organizationId,
      dto.ids,
      dto.coreIds,
    );
  }

  @ApiOperation({ summary: 'Desactivar ingrediente' })
  @RequirePermissions('inventory:manage')
  @HttpCode(HttpStatus.OK)
  @Delete('ingredients/:id')
  deactivateIngredient(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
  ) {
    return this.inventory.deactivateIngredient(user.organizationId, id);
  }

  // --------------------------------------------------------------------------
  // Equivalencias
  // --------------------------------------------------------------------------

  @ApiOperation({ summary: 'Equivalencias entre dimensiones del ingrediente' })
  @Get('ingredients/:id/equivalences')
  listEquivalences(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
  ) {
    return this.inventory.listEquivalences(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Crear equivalencia (ej. 1 taza = 120 g)' })
  @RequirePermissions('inventory:manage')
  @Post('ingredients/:id/equivalences')
  createEquivalence(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreateEquivalenceDto,
  ) {
    return this.inventory.createEquivalence(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Eliminar equivalencia' })
  @RequirePermissions('inventory:manage')
  @HttpCode(HttpStatus.OK)
  @Delete('ingredients/:id/equivalences/:equivalenceId')
  deleteEquivalence(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('equivalenceId') equivalenceId: string,
  ) {
    return this.inventory.deleteEquivalence(
      user.organizationId,
      id,
      equivalenceId,
    );
  }

  // --------------------------------------------------------------------------
  // Movimientos y alertas
  // --------------------------------------------------------------------------

  @ApiOperation({ summary: 'Kardex de movimientos de inventario' })
  @Get('movements')
  listMovements(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('ingredientId') ingredientId?: string,
    @Query('type') type?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    return this.inventory.listMovements(
      user.organizationId,
      {
        ingredientId,
        type: parseMovementType(type),
        from: parseDate(from, 'from'),
        to: parseDate(to, 'to'),
        limit: parseInteger(limit, 50),
        offset: parseInteger(offset, 0),
      },
      branchId,
    );
  }

  @ApiOperation({ summary: 'Registrar ajuste manual de stock (auditable)' })
  @RequirePermissions('inventory:adjust')
  @Post('movements')
  adjust(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateAdjustmentDto,
  ) {
    return this.inventory.adjust(user.organizationId, user.sub, dto, branchId);
  }

  @ApiOperation({ summary: 'Listar categorías de ingredientes (core + personalizadas)' })
  @Get('ingredient-categories')
  listIngredientCategories(
    @CurrentUser() user: JwtUser,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.inventory.listIngredientCategories(
      user.organizationId,
      includeInactive === 'true',
    );
  }

  @ApiOperation({ summary: 'Activar o desactivar todas las categorías core de inventario' })
  @RequirePermissions('inventory:manage')
  @Patch('ingredient-categories/bulk/core-status')
  setCoreIngredientCategoriesStatus(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateCoreIngredientCategoriesDto,
  ) {
    return this.inventory.setCoreIngredientCategoriesActive(
      user.organizationId,
      dto.isActive,
    );
  }

  @ApiOperation({ summary: 'Listar ubicaciones de ingredientes (core + personalizadas)' })
  @Get('ingredient-locations')
  listIngredientLocations(@CurrentUser() user: JwtUser) {
    return this.inventory.listIngredientLocations(user.organizationId);
  }

  @ApiOperation({ summary: 'Ingredientes por debajo del stock mínimo' })
  @Get('alerts')
  alerts(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.inventory.listAlerts(user.organizationId, branchId);
  }
}

function parseMovementType(value?: string): InventoryMovementType | undefined {
  if (!value) {
    return undefined;
  }

  if (!Object.values(InventoryMovementType).includes(value as InventoryMovementType)) {
    throw new BadRequestException('Tipo de movimiento inválido');
  }

  return value as InventoryMovementType;
}

function parseDate(value: string | undefined, field: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`El parámetro ${field} no es una fecha válida`);
  }

  return date;
}

function parseInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed)) {
    throw new BadRequestException('Se esperaba un número entero');
  }

  return parsed;
}
