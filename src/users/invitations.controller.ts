import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import { InvitationsService } from './invitations.service';

@ApiTags('users')
@Controller('users/invitations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @ApiOperation({ summary: 'Invitaciones pendientes del negocio' })
  @RequirePermissions('users:manage')
  @Get()
  list(@CurrentUser() user: JwtUser) {
    return this.invitations.list(user.organizationId);
  }

  @ApiOperation({ summary: 'Invitar a una persona por correo' })
  @RequirePermissions('users:manage')
  @Post()
  create(@CurrentUser() user: JwtUser, @Body() dto: CreateInvitationDto) {
    return this.invitations.create(user.organizationId, user.sub, dto);
  }

  @ApiOperation({ summary: 'Cancelar una invitación pendiente' })
  @RequirePermissions('users:manage')
  @Delete(':id')
  cancel(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.invitations.cancel(user.organizationId, id);
  }
}
