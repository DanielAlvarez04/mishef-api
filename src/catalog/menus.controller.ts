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
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { MenusService } from './menus.service';
import {
  CreateMenuDto,
  ReplaceMenuItemsDto,
  UpdateMenuDto,
} from './dto/menu.dto';

@ApiTags('catalog')
@Controller('catalog/menus')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MenusController {
  constructor(private readonly menus: MenusService) {}

  @ApiOperation({ summary: 'Listar menús de la organización' })
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.menus.list(
      user.organizationId,
      includeInactive === 'true',
    );
  }

  @ApiOperation({ summary: 'Detalle de un menú' })
  @Get(':id')
  findOne(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.menus.findOne(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Crear menú con artículos' })
  @RequirePermissions('catalog:manage')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateMenuDto) {
    return this.menus.create(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Editar menú y/o sus artículos' })
  @RequirePermissions('catalog:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateMenuDto,
  ) {
    return this.menus.update(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Duplicar menú como borrador inactivo' })
  @RequirePermissions('catalog:manage')
  @Post(':id/duplicate')
  duplicate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.menus.duplicate(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Desactivar menú' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id')
  deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.menus.deactivate(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Eliminar menú definitivamente' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id/permanent')
  remove(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.menus.remove(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Reemplazar los artículos del menú' })
  @RequirePermissions('catalog:manage')
  @Put(':id/items')
  replaceItems(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ReplaceMenuItemsDto,
  ) {
    return this.menus.replaceItems(
      user.organizationId,
      id,
      dto.items,
      dto.groups,
    );
  }
}
