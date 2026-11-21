import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
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
  constructor(private readonly intel: IntelService) {}

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
