import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { AuthService, JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PlatformAdminGuard } from '../billing/platform-admin.guard';
import { ImpersonateUserDto } from './dto/impersonate-user.dto';
import { PlatformUsersQueryDto } from './dto/platform-users-query.dto';
import { UsersService } from './users.service';

/**
 * Listado transversal de usuarios para el panel de plataforma.
 *
 * Vive fuera de `/users` para no mezclarlo con la gestión del equipo de un
 * negocio: aquí solo hay lectura y la apertura de sesiones de soporte.
 */
@ApiTags('platform-users')
@Controller('platform/users')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformUsersController {
  constructor(
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}

  @ApiOperation({ summary: 'Usuarios de todos los negocios' })
  @Get()
  list(@Query() query: PlatformUsersQueryDto) {
    return this.users.listPlatformUsers(query);
  }

  @ApiOperation({
    summary: 'Abrir una sesión de soporte de solo lectura como otro usuario',
  })
  @Post(':userId/impersonate')
  impersonate(
    @CurrentUser() actor: JwtUser,
    @Param('userId') userId: string,
    @Body() dto: ImpersonateUserDto,
    @Req() req: Request,
  ) {
    return this.auth.impersonate(actor, userId, dto.organizationId, {
      userAgent: req.get('user-agent') ?? undefined,
      ip: req.ip,
    });
  }
}
