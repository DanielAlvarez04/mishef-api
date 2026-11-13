import {
  Body,
  Controller,
  Get,
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
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';

@ApiTags('organizations')
@Controller('organizations')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @ApiOperation({ summary: 'Organización de la sesión actual' })
  @Get('current')
  current(@CurrentUser() user: JwtUser) {
    return this.organizations.current(user.organizationId);
  }

  @ApiOperation({ summary: 'Comprobar disponibilidad de un dominio' })
  @RequirePermissions('organization:manage')
  @Get('domain-available')
  domainAvailable(@Query('domain') domain?: string) {
    return this.organizations.domainAvailable(domain ?? '');
  }

  @ApiOperation({ summary: 'Renombrar la organización (solo ADMIN)' })
  @RequirePermissions('organization:manage')
  @Patch('current')
  update(@CurrentUser() user: JwtUser, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Cerrar el modo práctica de la organización' })
  @Post('current/practice/end')
  endPractice(@CurrentUser() user: JwtUser) {
    return this.organizations.endPractice(user.organizationId);
  }
}
