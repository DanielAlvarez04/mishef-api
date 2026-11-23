import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AiProposalStatus } from '@prisma/client';

import { JwtUser } from '../../auth/auth.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CatalogAiService } from './catalog-ai.service';
import {
  ApplyCatalogProposalDto,
  GenerateCatalogProposalsDto,
} from './dto/catalog-ai.dto';

@ApiTags('intel-catalog')
@Controller('intel/catalog')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CatalogAiController {
  constructor(private readonly catalogAi: CatalogAiService) {}

  @ApiOperation({ summary: 'Propuestas de la IA para el catálogo' })
  @RequirePermissions('catalog:manage')
  @Get('proposals')
  list(
    @CurrentUser() user: JwtUser,
    @Query('status') status?: string,
  ) {
    return this.catalogAi.list(
      organizationId(user),
      parseStatus(status) ?? AiProposalStatus.PROPOSED,
    );
  }

  @ApiOperation({
    summary: 'Generar propuestas editables (no escribe el catálogo)',
  })
  @RequirePermissions('catalog:manage')
  @Post('proposals')
  generate(
    @CurrentUser() user: JwtUser,
    @Body() dto: GenerateCatalogProposalsDto,
  ) {
    return this.catalogAi.generate(
      organizationId(user),
      user.sub,
      dto.itemIds,
      dto.fields,
    );
  }

  @ApiOperation({ summary: 'Aplicar una propuesta aprobada por una persona' })
  @RequirePermissions('catalog:manage')
  @Post('proposals/:id/apply')
  apply(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ApplyCatalogProposalDto,
  ) {
    return this.catalogAi.apply(organizationId(user), user.sub, id, dto.fields);
  }

  @ApiOperation({ summary: 'Descartar una propuesta' })
  @RequirePermissions('catalog:manage')
  @Post('proposals/:id/dismiss')
  dismiss(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.catalogAi.dismiss(organizationId(user), user.sub, id);
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene organización');
  }

  return user.organizationId;
}

function parseStatus(value: string | undefined): AiProposalStatus | null {
  if (!value) return null;

  return Object.values(AiProposalStatus).includes(value as AiProposalStatus)
    ? (value as AiProposalStatus)
    : null;
}
