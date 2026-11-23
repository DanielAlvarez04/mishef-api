import {
  BadRequestException,
  Controller,
  Get,
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
import { AnomaliesQueryDto } from './dto/anomalies.dto';

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
}

function organizationId(user: JwtUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('La sesión no tiene organización');
  }

  return user.organizationId;
}
