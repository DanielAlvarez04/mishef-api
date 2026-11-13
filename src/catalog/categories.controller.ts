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
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CategoryKind } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CategoriesService } from './categories.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  UpdateCoreCategoryGroupDto,
} from './dto/category.dto';

@ApiTags('catalog')
@Controller('catalog/categories')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @ApiOperation({ summary: 'Listar categorías de artículos o recetas' })
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('includeInactive') includeInactive?: string,
    @Query('kind') kind?: string,
  ) {
    const normalized =
      kind?.toLowerCase() === 'recipe'
        ? CategoryKind.RECIPE
        : CategoryKind.ARTICLE;

    return this.categories.list(
      user.organizationId,
      includeInactive === 'true',
      normalized,
    );
  }

  @ApiOperation({ summary: 'Crear categoría' })
  @RequirePermissions('catalog:manage')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateCategoryDto) {
    return this.categories.create(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Editar categoría' })
  @RequirePermissions('catalog:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    return this.categories.update(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Activar o desactivar todas las categorías core de un tipo' })
  @RequirePermissions('catalog:manage')
  @Patch('bulk/core-status')
  setCoreGroupStatus(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateCoreCategoryGroupDto,
  ) {
    return this.categories.setCoreGroupActive(
      user.organizationId,
      dto.kind,
      dto.isActive,
    );
  }

  @ApiOperation({ summary: 'Desactivar categoría' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id')
  deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.categories.deactivate(user.organizationId, id);
  }
}
