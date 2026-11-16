import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InvitationsService } from './invitations.service';

/**
 * Canje de invitaciones. Público a propósito: la persona todavía no tiene
 * sesión. El token es la credencial y se guarda hasheado.
 */
@ApiTags('public')
@Controller('public/invitations')
export class PublicInvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @ApiOperation({ summary: 'Datos de la invitación (vista previa)' })
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get(':token')
  preview(@Param('token') token: string) {
    return this.invitations.preview(token);
  }

  @ApiOperation({ summary: 'Aceptar la invitación' })
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(200)
  @Post(':token/accept')
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(token, dto);
  }
}
