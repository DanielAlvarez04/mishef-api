import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { JwtUser } from '../auth/auth.service'
import { CurrentUser } from '../auth/decorators/current-user.decorator'
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard'
import { CurrentBranch } from '../common/decorators/current-branch.decorator'
import { RequirePermissions } from '../common/decorators/require-permissions.decorator'
import { RolesGuard } from '../common/guards/roles.guard'
import { AnalyticsService } from './analytics.service'
import { TrackAnalyticsEventsDto } from './dto/analytics.dto'

@ApiTags('analytics')
@Controller('analytics')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @ApiOperation({ summary: 'Registrar eventos de uso del POS' })
  @Post('events')
  track(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: TrackAnalyticsEventsDto,
  ) {
    return this.analytics.trackClientEvents({
      organizationId: user.organizationId,
      branchId,
      userId: user.sub,
      events: dto.events,
    })
  }

  @ApiOperation({ summary: 'Grupos de opciones más usados' })
  @RequirePermissions('reports:read')
  @Get('option-groups/top')
  topOptionGroups(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const range = parseRange(from, to)

    return this.analytics.topOptionGroups({
      organizationId: user.organizationId,
      branchId,
      ...range,
      limit: parseLimit(limit),
    })
  }

  @ApiOperation({ summary: 'Opciones más elegidas por grupo' })
  @RequirePermissions('reports:read')
  @Get('option-values/top')
  topOptionValues(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const range = parseRange(from, to)

    return this.analytics.topOptionValues({
      organizationId: user.organizationId,
      branchId,
      ...range,
      limit: parseLimit(limit),
    })
  }

  @ApiOperation({ summary: 'Eventos de analítica del periodo' })
  @RequirePermissions('reports:read')
  @Get('events')
  events(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('name') name?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const range = parseRange(from, to)

    return this.analytics.listEvents({
      organizationId: user.organizationId,
      branchId,
      name: name?.trim() || undefined,
      ...range,
      limit: parseLimit(limit, 200),
    })
  }
}

function parseRange(from?: string, to?: string): { from: Date; to: Date } {
  const end = to ? new Date(to) : new Date()
  const start = from ? new Date(from) : new Date(end.getTime() - 29 * 86400000)

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new BadRequestException('El periodo no es válido')
  }

  if (start > end) {
    throw new BadRequestException('El inicio del periodo es posterior al fin')
  }

  if (from && from.length === 10) start.setHours(0, 0, 0, 0)
  if (to && to.length === 10) end.setHours(23, 59, 59, 999)

  return { from: start, to: end }
}

function parseLimit(value: string | undefined, fallback = 20): number {
  if (!value) return fallback

  const parsed = Number(value)

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new BadRequestException('El límite no es válido')
  }

  return Math.min(parsed, 100)
}
