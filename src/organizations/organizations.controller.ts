import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
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
import { SetDomainDto } from './dto/set-domain.dto';
import { ChangeSlugDto } from './dto/change-slug.dto';

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

  @ApiOperation({ summary: 'Buscar direcciones para ubicar el negocio' })
  @RequirePermissions('organization:manage')
  @Get('location-search')
  searchLocation(@Query('q') query?: string) {
    return this.organizations.searchLocation(query ?? '');
  }

  @ApiOperation({ summary: 'Renombrar la organización (solo ADMIN)' })
  @RequirePermissions('organization:manage')
  @Patch('current')
  update(@CurrentUser() user: JwtUser, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(user.organizationId, dto);
  }

  @ApiOperation({ summary: 'Cambiar la dirección del negocio (una vez)' })
  @RequirePermissions('organization:manage')
  @Patch('slug')
  changeSlug(@CurrentUser() user: JwtUser, @Body() dto: ChangeSlugDto) {
    return this.organizations.changeSlug(
      user.organizationId,
      user.sub,
      dto.slug,
    );
  }

  @ApiOperation({ summary: 'Conectar un dominio propio (queda pendiente)' })
  @RequirePermissions('organization:manage')
  @Put('domain')
  setDomain(@CurrentUser() user: JwtUser, @Body() dto: SetDomainDto) {
    return this.organizations.setDomain(user.organizationId, dto.domain);
  }

  @ApiOperation({ summary: 'Verificar el dominio contra el DNS' })
  @HttpCode(200)
  @RequirePermissions('organization:manage')
  @Post('domain/verify')
  verifyDomain(@CurrentUser() user: JwtUser) {
    return this.organizations.verifyDomain(user.organizationId);
  }

  @ApiOperation({ summary: 'Desconectar el dominio propio' })
  @RequirePermissions('organization:manage')
  @Delete('domain')
  removeDomain(@CurrentUser() user: JwtUser) {
    return this.organizations.removeDomain(user.organizationId);
  }

  @ApiOperation({ summary: 'Cerrar el modo práctica de la organización' })
  @Post('current/practice/end')
  endPractice(@CurrentUser() user: JwtUser) {
    return this.organizations.endPractice(user.organizationId);
  }
}
