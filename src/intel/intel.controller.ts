import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { JwtUser } from '../auth/auth.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { IntelDigestService } from './digest/intel-digest.service';
import {
  IntelChatDto,
  IntelFeedbackDto,
  IntelSettingsDto,
} from './dto/intel.dto';
import { IntelService } from './intel.service';

@ApiTags('intel')
@Controller('intel')
@UseGuards(JwtAuthGuard, RolesGuard)
export class IntelController {
  constructor(
    private readonly intel: IntelService,
    private readonly digest: IntelDigestService,
  ) {}

  @ApiOperation({ summary: 'Configuración y consumo de Intel' })
  @RequirePermissions('intel:use')
  @Get('config')
  getConfig(@CurrentUser() user: JwtUser) {
    return this.intel.getConfig(user);
  }

  @ApiOperation({ summary: 'Activar o desactivar Intel para el negocio' })
  @RequirePermissions('organization:manage')
  @Patch('settings')
  setSettings(
    @CurrentUser() user: JwtUser,
    @Body() dto: IntelSettingsDto,
  ) {
    return this.intel.setEnabled(user, dto.enabled);
  }

  @ApiOperation({ summary: 'Conversaciones del copiloto' })
  @RequirePermissions('intel:use')
  @Get('conversations')
  listConversations(@CurrentUser() user: JwtUser) {
    return this.intel.listConversations(user);
  }

  @ApiOperation({ summary: 'Mensajes de una conversación' })
  @RequirePermissions('intel:use')
  @Get('conversations/:id')
  getConversation(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
  ) {
    return this.intel.getConversation(user, id);
  }

  @ApiOperation({ summary: 'Eliminar una conversación' })
  @RequirePermissions('intel:use')
  @Delete('conversations/:id')
  deleteConversation(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
  ) {
    return this.intel.deleteConversation(user, id);
  }

  @ApiOperation({ summary: 'Consumo de IA del mes' })
  @RequirePermissions('intel:use')
  @Get('usage')
  getUsage(@CurrentUser() user: JwtUser) {
    return this.intel.getUsage(user);
  }

  @ApiOperation({ summary: 'Bandeja de notificaciones de Intel' })
  @RequirePermissions('intel:use')
  @Get('notifications')
  listNotifications(
    @CurrentUser() user: JwtUser,
    @Query('unreadOnly') unreadOnly?: string,
    @Query('limit') limit?: string,
  ) {
    const parsed = Number(limit);
    const take = Number.isFinite(parsed) ? parsed : 50;

    return this.intel.listNotifications(
      user,
      unreadOnly === 'true' || unreadOnly === '1',
      take,
    );
  }

  @ApiOperation({ summary: 'Notificaciones no leídas' })
  @RequirePermissions('intel:use')
  @Get('notifications/unread-count')
  unreadNotifications(@CurrentUser() user: JwtUser) {
    return this.intel.unreadNotifications(user);
  }

  @ApiOperation({ summary: 'Marcar una notificación como leída' })
  @RequirePermissions('intel:use')
  @Patch('notifications/:id/read')
  markNotificationRead(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
  ) {
    return this.intel.markNotificationRead(user, id);
  }

  @ApiOperation({ summary: 'Marcar todas las notificaciones como leídas' })
  @RequirePermissions('intel:use')
  @Post('notifications/read-all')
  markAllNotificationsRead(@CurrentUser() user: JwtUser) {
    return this.intel.markAllNotificationsRead(user);
  }

  @ApiOperation({ summary: 'Generar el digest diario ahora (ADMIN)' })
  @RequirePermissions('organization:manage')
  @Post('digest')
  runDigest(@CurrentUser() user: JwtUser) {
    if (!user.organizationId) {
      throw new BadRequestException('La sesión no tiene organización');
    }

    return this.digest.generateForOrganization(user.organizationId);
  }

  @ApiOperation({ summary: 'Chat del copiloto (SSE)' })
  @RequirePermissions('intel:use')
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('chat')
  chat(
    @CurrentUser() user: JwtUser,
    @Body() dto: IntelChatDto,
    @Res() res: Response,
    @Req() req: Request,
  ) {
    return this.intel.chat(user, dto, res, req);
  }

  @ApiOperation({ summary: 'Feedback de una respuesta' })
  @RequirePermissions('intel:use')
  @Post('feedback')
  feedback(
    @CurrentUser() user: JwtUser,
    @Body() dto: IntelFeedbackDto,
  ) {
    return this.intel.feedback(user, dto);
  }
}
