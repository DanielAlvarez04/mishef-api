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

import { JwtUser } from '../../auth/auth.service';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AnomaliesService } from './anomalies.service';
import {
  AnomaliesQueryDto,
  ReviewAnomalyDto,
} from './dto/anomalies.dto';

@ApiTags('intel-anomalies')
@Controller('intel/anomalies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  @ApiOperation({
    summary: 'Anomalías explicables de caja, descuentos, cancelaciones y mermas',
  })
  @RequirePermissions('costs:read')
  @Get()
  findings(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query() query: AnomaliesQueryDto,
  ) {
    return this.anomalies.findings(organizationId(user), branchId, query);
  }

  @ApiOperation({ summary: 'Reconocer o descartar una anomalía' })
  @RequirePermissions('costs:read')
  @Post(':key/review')
  review(
    @CurrentUser() user: JwtUser,
    @Param('key') key: string,
    @Body() dto: ReviewAnomalyDto,
  ) {
    return this.anomalies.review(
      organizationId(user),
      user.sub,
      key,
      dto.status,
      dto.note,
    );
  }
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene organización');
  }

  return user.organizationId;
}
