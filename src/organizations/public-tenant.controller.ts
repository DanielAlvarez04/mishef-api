import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrganizationsService } from './organizations.service';

/**
 * Consultas que necesita el formulario de registro **antes** de que exista una
 * sesión. Por eso viven fuera del controlador autenticado: no hay token que
 * validar todavía.
 *
 * No exponen datos de ningún negocio: solo responden “esta dirección está
 * libre” o “te sugiero esta”.
 */
@ApiTags('public')
@Controller('public')
export class PublicTenantController {
  constructor(private readonly organizations: OrganizationsService) {}

  @ApiOperation({ summary: 'Disponibilidad de una dirección de negocio' })
  @Get('slug-available')
  slugAvailable(@Query('slug') slug?: string) {
    return this.organizations.slugAvailable(slug ?? '');
  }

  @ApiOperation({ summary: 'Sugerir dirección a partir del nombre del negocio' })
  @Get('slug-suggestion')
  slugSuggestion(@Query('name') name?: string) {
    return this.organizations.slugSuggestion(name ?? '');
  }

  @ApiOperation({ summary: 'Datos públicos de un negocio por su dirección' })
  @Get('tenant/:slug')
  tenant(@Param('slug') slug: string) {
    return this.organizations.tenant(slug);
  }
}
