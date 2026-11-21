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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { DeleteMembershipsDto } from './dto/delete-memberships.dto';

@ApiTags('users')
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
@RequirePermissions('users:manage')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOperation({ summary: 'Listar usuarios de la organización' })
  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.users.list(user.organizationId);
  }

  @ApiOperation({ summary: 'Comprobar disponibilidad de un nombre de usuario' })
  @Get('username-available')
  usernameAvailable(
    @CurrentUser() user: JwtUser,
    @Query('username') username?: string,
  ) {
    return this.users.usernameAvailable(user.organizationId, username ?? '');
  }

  @ApiOperation({ summary: 'Proponer un nombre de usuario a partir del nombre' })
  @Get('username-suggestion')
  suggestUsername(
    @CurrentUser() user: JwtUser,
    @Query('name') name?: string,
  ) {
    return this.users.suggestUsername(user.organizationId, name ?? '');
  }

  @ApiOperation({ summary: 'Crear usuario y asignarle roles' })
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateUserDto) {
    return this.users.create(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Actualizar nombre, roles o estado' })
  @Patch(':id')
  update(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.users.update(user.organizationId, id, dto, user.sub);
  }

  @ApiOperation({ summary: 'Purgar todas las membresías desactivadas de la organización (hard delete masivo)' })
  @HttpCode(HttpStatus.OK)
  @Delete('purge-deleted')
  purgeDeleted(@CurrentUser() user: JwtUser) {
    return this.users.purgeDeletedUsers(user.organizationId);
  }

  @ApiOperation({ summary: 'Eliminar varios usuarios de la organización (hard delete masivo)' })
  @HttpCode(HttpStatus.OK)
  @Delete('memberships')
  deleteMemberships(
    @CurrentUser() user: JwtUser,
    @Body() dto: DeleteMembershipsDto,
  ) {
    return this.users.deleteMemberships(
      user.organizationId,
      dto.userIds,
      user.sub,
    );
  }

  @ApiOperation({ summary: 'Desactivar un usuario de la organización (soft delete)' })
  @HttpCode(HttpStatus.OK)
  @Delete(':id')
  deactivate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.users.deactivate(user.organizationId, id, user.sub);
  }

  @ApiOperation({ summary: 'Eliminar membresía del usuario de la organización (hard delete)' })
  @HttpCode(HttpStatus.OK)
  @Delete(':id/membership')
  deleteMembership(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.users.deleteMembership(user.organizationId, id, user.sub);
  }
}
