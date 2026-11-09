import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CatalogEntriesService } from '../catalog/catalog-entries.service';
import { FinalizeImageDto } from './dto/finalize-image.dto';
import { PresignImageDto } from './dto/presign-image.dto';
import { UploadsService } from './uploads.service';

@ApiTags('uploads')
@Controller('uploads')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UploadsController {
  constructor(
    private readonly uploads: UploadsService,
    private readonly catalogEntries: CatalogEntriesService,
  ) {}

  @ApiOperation({
    summary: 'Firmar la subida de la imagen de un artículo',
  })
  @RequirePermissions('catalog:manage')
  @Post('catalog/items/:itemId')
  async presignItemImage(
    @CurrentUser() user: JwtUser,
    @Param('itemId') itemId: string,
    @Body() dto: PresignImageDto,
  ) {
    const entryId = await this.catalogEntries.ensureForItem(
      user.organizationId,
      itemId,
    );

    return this.uploads.presignImage(
      user.organizationId,
      'catalog',
      entryId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Optimizar la imagen de un artículo',
  })
  @RequirePermissions('catalog:manage')
  @Post('catalog/items/:itemId/finalize')
  async finalizeItemImage(
    @CurrentUser() user: JwtUser,
    @Param('itemId') itemId: string,
    @Body() dto: FinalizeImageDto,
  ) {
    const entryId = await this.catalogEntries.ensureForItem(
      user.organizationId,
      itemId,
    );

    return this.uploads.finalizeImage(
      user.organizationId,
      'catalog',
      entryId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Firmar la subida de la imagen de una presentación',
  })
  @RequirePermissions('catalog:manage')
  @Post('catalog/items/:itemId/variants/:variantId')
  async presignVariantImage(
    @CurrentUser() user: JwtUser,
    @Param('itemId') itemId: string,
    @Param('variantId') variantId: string,
    @Body() dto: PresignImageDto,
  ) {
    const entryId = await this.catalogEntries.ensureForVariant(
      user.organizationId,
      itemId,
      variantId,
    );

    return this.uploads.presignVariantImage(
      user.organizationId,
      entryId,
      variantId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Optimizar la imagen de una presentación',
  })
  @RequirePermissions('catalog:manage')
  @Post('catalog/items/:itemId/variants/:variantId/finalize')
  async finalizeVariantImage(
    @CurrentUser() user: JwtUser,
    @Param('itemId') itemId: string,
    @Param('variantId') variantId: string,
    @Body() dto: FinalizeImageDto,
  ) {
    const entryId = await this.catalogEntries.ensureForVariant(
      user.organizationId,
      itemId,
      variantId,
    );

    return this.uploads.finalizeVariantImage(
      user.organizationId,
      entryId,
      variantId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Firmar la subida de la imagen de una receta',
  })
  @RequirePermissions('catalog:manage')
  @Post('catalog/recipes/:recipeId')
  async presignRecipeImage(
    @CurrentUser() user: JwtUser,
    @Param('recipeId') recipeId: string,
    @Body() dto: PresignImageDto,
  ) {
    const entryId = await this.catalogEntries.ensureForRecipe(
      user.organizationId,
      recipeId,
    );

    return this.uploads.presignImage(
      user.organizationId,
      'catalog',
      entryId,
      dto,
    );
  }

  @ApiOperation({
    summary: 'Optimizar la imagen de una receta',
  })
  @RequirePermissions('catalog:manage')
  @Post('catalog/recipes/:recipeId/finalize')
  async finalizeRecipeImage(
    @CurrentUser() user: JwtUser,
    @Param('recipeId') recipeId: string,
    @Body() dto: FinalizeImageDto,
  ) {
    const entryId = await this.catalogEntries.ensureForRecipe(
      user.organizationId,
      recipeId,
    );

    return this.uploads.finalizeImage(
      user.organizationId,
      'catalog',
      entryId,
      dto,
    );
  }

  @ApiOperation({ summary: 'Firmar la subida de la imagen de un insumo' })
  @RequirePermissions('inventory:manage')
  @Post('inventory/ingredients/:ingredientId')
  presignIngredientImage(
    @CurrentUser() user: JwtUser,
    @Param('ingredientId') ingredientId: string,
    @Body() dto: PresignImageDto,
  ) {
    return this.uploads.presignImage(
      user.organizationId,
      'inventory',
      ingredientId,
      dto,
    );
  }
}
