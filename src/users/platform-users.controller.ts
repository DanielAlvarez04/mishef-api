import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { PlatformUsersQueryDto } from './dto/platform-users-query.dto';
import { UsersService } from './users.service';

/**
 * Listado transversal de usuarios para el panel de plataforma.
 *
 * Vive fuera de `/users` para no mezclarlo con la gestión del equipo de un
 * negocio: aquí no hay mutaciones, solo lectura.
 */
@ApiTags('platform-users')
@Controller('platform/users')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformUsersController {
  constructor(private readonly users: UsersService) {}

  @ApiOperation({ summary: 'Usuarios de todos los negocios' })
  @Get()
  list(@Query() query: PlatformUsersQueryDto) {
    return this.users.listPlatformUsers(query);
  }
}
