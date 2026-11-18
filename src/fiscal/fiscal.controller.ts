import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { UpsertFiscalProfileDto } from './dto/fiscal-profile.dto';
import { FiscalService } from './fiscal.service';

@ApiTags('fiscal')
@Controller('fiscal')
@UseGuards(JwtAuthGuard, RolesGuard)
@RequirePermissions('organization:manage')
export class FiscalController {
  constructor(private readonly fiscal: FiscalService) {}

  @ApiOperation({ summary: 'Datos fiscales del negocio' })
  @Get('profile')
  get(@CurrentUser() user: JwtUser) {
    return this.fiscal.get(organizationId(user));
  }

  @ApiOperation({ summary: 'Guardar datos fiscales del negocio' })
  @Put('profile')
  upsert(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpsertFiscalProfileDto,
  ) {
    return this.fiscal.upsert(organizationId(user), dto);
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene un negocio activo');
  }

  return user.organizationId;
}
