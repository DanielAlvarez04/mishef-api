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
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import {
  CreateKitchenPositionDto,
  CreateKitchenRoutingDto,
  CreateKitchenStationDto,
  UpdateKitchenAssignmentDto,
  UpdateKitchenModeDto,
  UpdateKitchenPositionDto,
  UpdateKitchenRoutingDto,
  UpdateKitchenStationDto,
} from './dto/kitchen-config.dto';
import { KitchenConfigService } from './kitchen-config.service';

@ApiTags('kitchen-config')
@Controller('kitchen')
@UseGuards(JwtAuthGuard, RolesGuard)
@RequirePermissions('organization:manage')
export class KitchenConfigController {
  constructor(private readonly config: KitchenConfigService) {}

  @ApiOperation({ summary: 'Configuración completa de cocina de la sucursal' })
  @Get('config')
  getConfig(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.config.config(user.organizationId, branchId);
  }

  @ApiOperation({ summary: 'Cambiar el modo de cocina de la sucursal' })
  @Patch('mode')
  updateMode(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: UpdateKitchenModeDto,
  ) {
    return this.config.updateMode(user.organizationId, branchId, dto.mode);
  }

  @ApiOperation({ summary: 'Crear los puestos preset de la brigada' })
  @Post('positions/presets')
  seedPresets(@CurrentUser() user: JwtUser) {
    return this.config.seedPresets(user.organizationId);
  }

  @ApiOperation({ summary: 'Crear estación de cocina' })
  @Post('stations')
  createStation(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateKitchenStationDto,
  ) {
    return this.config.createStation(user.organizationId, branchId, dto);
  }

  @ApiOperation({ summary: 'Actualizar estación de cocina' })
  @Patch('stations/:id')
  updateStation(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateKitchenStationDto,
  ) {
    return this.config.updateStation(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Desactivar estación de cocina' })
  @HttpCode(HttpStatus.OK)
  @Delete('stations/:id')
  deactivateStation(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.config.deactivateStation(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Crear puesto de brigada' })
  @Post('positions')
  createPosition(
    @CurrentUser() user: JwtUser,
    @Body() dto: CreateKitchenPositionDto,
  ) {
    return this.config.createPosition(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Actualizar puesto de brigada' })
  @Patch('positions/:id')
  updatePosition(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateKitchenPositionDto,
  ) {
    return this.config.updatePosition(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Desactivar puesto de brigada' })
  @HttpCode(HttpStatus.OK)
  @Delete('positions/:id')
  deactivatePosition(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.config.deactivatePosition(user.organizationId, id);
  }

  @ApiOperation({ summary: 'Asignar puesto y estaciones a un miembro' })
  @Put('assignments/:membershipId')
  updateAssignment(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Param('membershipId') membershipId: string,
    @Body() dto: UpdateKitchenAssignmentDto,
  ) {
    return this.config.updateAssignment(
      user.organizationId,
      branchId,
      membershipId,
      dto,
    );
  }

  @ApiOperation({ summary: 'Crear regla de ruteo a estación' })
  @Post('routing')
  createRouting(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: CreateKitchenRoutingDto,
  ) {
    return this.config.createRouting(user.organizationId, branchId, dto);
  }

  @ApiOperation({ summary: 'Actualizar regla de ruteo' })
  @Patch('routing/:id')
  updateRouting(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateKitchenRoutingDto,
  ) {
    return this.config.updateRouting(user.organizationId, id, dto);
  }

  @ApiOperation({ summary: 'Eliminar regla de ruteo' })
  @HttpCode(HttpStatus.OK)
  @Delete('routing/:id')
  deleteRouting(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.config.deleteRouting(user.organizationId, id);
  }
}
