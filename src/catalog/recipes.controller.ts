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
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { RecipesService, type RecipeFilters } from './recipes.service';
import {
  CreateRecipeDto,
  ProduceRecipeDto,
  PublishRecipeDto,
  SaveRecipeDraftItemDto,
  UpdateRecipeDto,
} from './dto/recipe.dto';

@ApiTags('catalog')
@Controller('catalog/recipes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RecipesController {
  constructor(private readonly recipes: RecipesService) {}

  @ApiOperation({ summary: 'Listar recetas (independientes y publicadas)' })
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('search') search?: string,
    @Query('categoryId') categoryId?: string,
    @Query('includeInactive') includeInactive?: string,
    @Query('publication') publication?: string,
    @Query('producesIngredient') producesIngredient?: string,
  ) {
    const filters: RecipeFilters = {
      search,
      categoryId,
      includeInactive: includeInactive === 'true',
      publication:
        publication === 'published' || publication === 'standalone'
          ? publication
          : undefined,
      producesIngredient: producesIngredient === 'true',
    };

    return this.recipes.list(user.organizationId, filters);
  }

  @ApiOperation({ summary: 'Detalle de una receta' })
  @Get(':id')
  findOne(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.recipes.findOne(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Crear receta (opcionalmente publicarla o convertirla en insumo)' })
  @RequirePermissions('catalog:manage')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateRecipeDto) {
    return this.recipes.create(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Editar receta' })
  @RequirePermissions('catalog:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateRecipeDto,
  ) {
    return this.recipes.update(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Reemplazar los ingredientes de la receta' })
  @RequirePermissions('catalog:manage')
  @Put(':id/ingredients')
  replaceIngredients(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateRecipeDto,
  ) {
    return this.recipes.update(user.organizationId, id, {
      ingredients: dto.ingredients,
    });
  }

  @ApiOperation({
    summary: 'Guardar el borrador de artículo (presentaciones y opciones) de una receta',
  })
  @RequirePermissions('catalog:manage')
  @Put(':id/draft-item')
  saveDraftItem(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: SaveRecipeDraftItemDto,
  ) {
    return this.recipes.saveDraftItem(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Eliminar receta (debe estar despublicada)' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id')
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.recipes.remove(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Publicar la receta como artículo' })
  @RequirePermissions('catalog:manage')
  @Post(':id/publish')
  publish(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: PublishRecipeDto,
  ) {
    return this.recipes.publish(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Quitar el artículo de la receta' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id/publish')
  unpublish(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.recipes.unpublish(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Producir un lote del insumo de la receta' })
  @RequirePermissions('catalog:manage')
  @Post(':id/produce')
  produce(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Param('id') id: string,
    @Body() dto: ProduceRecipeDto,
  ) {
    return this.recipes.produce(
      user.organizationId,
      user.sub,
      id,
      dto,
      branchId,
    );
  }
}
