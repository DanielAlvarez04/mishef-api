import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtUser } from '../../auth/auth.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  ComparisonQueryDto,
  ForecastFeedbackDto,
  ForecastQueryDto,
  SuggestionsQueryDto,
} from './dto/forecast.dto';
import { ForecastService } from './forecast.service';

@ApiTags('intel-forecast')
@Controller('intel/forecast')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ForecastController {
  constructor(private readonly forecast: ForecastService) {}

  @ApiOperation({ summary: 'Pronóstico de consumo por insumo' })
  @RequirePermissions('purchases:read')
  @Get()
  overview(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query() query: ForecastQueryDto,
  ) {
    return this.forecast.overview(organizationId(user), branchId, {
      days: query.days,
      limit: query.limit,
      ingredientId: query.ingredientId,
    });
  }

  @ApiOperation({ summary: 'Sugerencias de compra explicadas' })
  @RequirePermissions('purchases:read')
  @Get('suggestions')
  suggestions(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query() query: SuggestionsQueryDto,
  ) {
    return this.forecast.suggestions(
      organizationId(user),
      branchId,
      query.coverDays,
      query.limit,
    );
  }

  @ApiOperation({ summary: 'Cambios de precio por proveedor' })
  @RequirePermissions('purchases:read')
  @Get('price-alerts')
  priceAlerts(@CurrentUser() user: JwtUser) {
    return this.forecast.priceAlerts(organizationId(user));
  }

  @ApiOperation({ summary: 'Comparación de proveedores para un insumo' })
  @RequirePermissions('purchases:read')
  @Get('comparison')
  comparison(
    @CurrentUser() user: JwtUser,
    @Query() query: ComparisonQueryDto,
  ) {
    return this.forecast.comparison(organizationId(user), query.ingredientId);
  }

  @ApiOperation({ summary: 'Registrar si la sugerencia se aceptó o ajustó' })
  @RequirePermissions('purchases:read')
  @Post('feedback')
  feedback(
    @CurrentUser() user: JwtUser,
    @Body() dto: ForecastFeedbackDto,
  ) {
    return this.forecast.recordFeedback(organizationId(user), user.sub, dto);
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene organización');
  }

  return user.organizationId;
}
