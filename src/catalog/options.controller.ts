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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CreateOptionGroupDto,
  OptionValueInputDto,
  UpdateCoreOptionGroupStatusDto,
  UpdateOptionGroupDto,
  UpdateOptionValueDto,
} from './dto/option.dto';
import { OptionsService } from './options.service';

@ApiTags('catalog')
@Controller('catalog/option-groups')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OptionsController {
  constructor(private readonly options: OptionsService) {}

  @ApiOperation({ summary: 'Listar grupos de opciones del negocio' })
  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.options.list(user.organizationId);
  }

  @ApiOperation({ summary: 'Plantillas de grupos sugeridas por la app' })
  @Get('presets')
  presets() {
    return this.options.presets();
  }

  @ApiOperation({ summary: 'Activar o desactivar los grupos core sugeridos' })
  @RequirePermissions('catalog:manage')
  @Patch('core-status')
  setCoreStatus(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateCoreOptionGroupStatusDto,
  ) {
    return this.options.setCoreActive(user.organizationId, dto.isActive);
  }

  @ApiOperation({ summary: 'Crear grupo de opciones' })
  @RequirePermissions('catalog:manage')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateOptionGroupDto) {
    return this.options.create(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Editar grupo de opciones' })
  @RequirePermissions('catalog:manage')
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateOptionGroupDto,
  ) {
    return this.options.update(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Desactivar grupo de opciones' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id')
  deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.options.deactivate(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Añadir valor al grupo' })
  @RequirePermissions('catalog:manage')
  @Post(':id/values')
  createValue(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: OptionValueInputDto,
  ) {
    return this.options.createValue(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Editar valor del grupo' })
  @RequirePermissions('catalog:manage')
  @Patch(':id/values/:valueId')
  updateValue(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('valueId') valueId: string,
    @Body() dto: UpdateOptionValueDto,
  ) {
    return this.options.updateValue(user.organizationId, id, valueId, dto);
  }

  @ApiOperation({ summary: 'Desactivar valor del grupo' })
  @RequirePermissions('catalog:manage')
  @HttpCode(HttpStatus.OK)
  @Delete(':id/values/:valueId')
  deactivateValue(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Param('valueId') valueId: string,
  ) {
    return this.options.deactivateValue(user.organizationId, id, valueId);
  }
}
