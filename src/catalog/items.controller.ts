import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { ItemsService } from './items.service';
import { CatalogImportService } from './catalog-import.service';
import {
  CreateExtraDto,
  CreateItemDto,
  CreateVariantDto,
  DeleteItemsDto,
  ReplaceComboComponentsDto,
  ReplaceExclusionsDto,
  UpdateExtraDto,
  UpdateItemDto,
  UpdateVariantDto,
} from './dto/item.dto';
import { ImportItemsDto } from './dto/import.dto';

@ApiTags('catalog')
@Controller('catalog/items')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ItemsController {
  constructor(
    private readonly items: ItemsService,
    private readonly importer: CatalogImportService,
  ) {}

  @ApiOperation({ summary: 'Listar artículos del catálogo' })
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('onlyCombos') onlyCombos?: string,
  ) {
    return this.items.list(user.organizationId, {
      search,
      categoryId,
      includeInactive: includeInactive === 'true',
      onlyCombos: onlyCombos === 'true',
    });
  }

  @ApiOperation({ summary: 'Detalle de un artículo' })
  @Get(':id')
  findOne(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.items.findOne(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Crear artículo con variantes, extras y combo' })
  @RequirePermissions('catalog:manage')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateItemDto) {
    return this.items.create(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Importar artículos desde CSV' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Post('import')
  import(
    @CurrentUser() user: JwtUser,
    @Body() dto: ImportItemsDto,
  ) {
    return this.importer.importItems(
      user.organizationId,
      dto.csv,
      dto.dryRun ?? false,
    );
  }

  @ApiOperation({ summary: 'Eliminar artículos permanentemente (hard delete)' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Post('bulk-delete')
  deleteItems(@CurrentUser() user: JwtUser, @Body() dto: DeleteItemsDto) {
    return this.items.deleteItems(user.organizationId, dto.ids);
  }

  @ApiOperation({ summary: 'Editar datos generales del artículo' })
  @RequirePermissions('catalog:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateItemDto,
  ) {
    return this.items.update(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Desactivar artículo' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id')
  deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.items.deactivate(user.organizationId, id);
  }

  // --------------------------------------------------------------------------
  // Variantes
  // --------------------------------------------------------------------------

  @ApiOperation({ summary: 'Añadir variante al artículo' })
  @RequirePermissions('catalog:manage')
  @Post(':id/variants')
  createVariant(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreateVariantDto,
  ) {
    return this.items.createVariant(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Editar variante' })
  @RequirePermissions('catalog:manage')
  @Patch(':id/variants/:variantId')
  updateVariant(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('variantId') variantId: string,
    @Body() dto: UpdateVariantDto,
  ) {
    return this.items.updateVariant(
      user.organizationId,
      id,
      variantId,
      dto,
    );
  }

  @ApiOperation({ summary: 'Desactivar variante' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id/variants/:variantId')
  deactivateVariant(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('variantId') variantId: string,
  ) {
    return this.items.deactivateVariant(
      user.organizationId,
      id,
      variantId,
    );
  }

  // --------------------------------------------------------------------------
  // Extras
  // --------------------------------------------------------------------------

  @ApiOperation({ summary: 'Añadir extra al artículo' })
  @RequirePermissions('catalog:manage')
  @Post(':id/extras')
  createExtra(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: CreateExtraDto,
  ) {
    return this.items.createExtra(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Editar extra y su consumo de inventario' })
  @RequirePermissions('catalog:manage')
  @Patch(':id/extras/:extraId')
  updateExtra(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('extraId') extraId: string,
    @Body() dto: UpdateExtraDto,
  ) {
    return this.items.updateExtra(user.organizationId, id, extraId, dto);
  }

  @ApiOperation({ summary: 'Desactivar extra' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id/extras/:extraId')
  deactivateExtra(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('extraId') extraId: string,
  ) {
    return this.items.deactivateExtra(user.organizationId, id, extraId);
  }

  // --------------------------------------------------------------------------
  // Exclusiones y combos
  // --------------------------------------------------------------------------

  @ApiOperation({ summary: 'Reemplazar ingredientes que se pueden quitar' })
  @RequirePermissions('catalog:manage')
  @Put(':id/exclusions')
  replaceExclusions(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ReplaceExclusionsDto,
  ) {
    return this.items.replaceExclusions(
      user.organizationId,
      id,
      dto.exclusions,
    );
  }

  @ApiOperation({ summary: 'Reemplazar componentes del combo' })
  @RequirePermissions('catalog:manage')
  @Put(':id/combo-components')
  replaceComboComponents(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ReplaceComboComponentsDto,
  ) {
    return this.items.replaceComboComponents(
      user.organizationId,
      id,
      dto.components,
    );
  }
}

