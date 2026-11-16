import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AttendanceService } from './attendance.service';
import { ClockInDto } from './dto/attendance.dto';

@ApiTags('attendance')
@Controller('attendance')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @ApiOperation({ summary: 'Turno abierto de la persona' })
  @RequirePermissions('attendance:clock')
  @Get('current')
  current(@CurrentUser() user: JwtUser) {
    return this.attendance.current(user.organizationId, user.sub);
  }

  @ApiOperation({ summary: 'Marcar entrada' })
  @RequirePermissions('attendance:clock')
  @HttpCode(201)
  @Post('clock-in')
  clockIn(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: ClockInDto,
  ) {
    return this.attendance.clockIn(
      user.organizationId,
      user.sub,
      branchId,
      dto.note,
    );
  }

  @ApiOperation({ summary: 'Marcar salida' })
  @RequirePermissions('attendance:clock')
  @HttpCode(200)
  @Post('clock-out')
  clockOut(@CurrentUser() user: JwtUser) {
    return this.attendance.clockOut(user.organizationId, user.sub);
  }

  @ApiOperation({ summary: 'Turnos del equipo en el periodo' })
  @RequirePermissions('attendance:read')
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.attendance.list(user.organizationId, branchId, from, to);
  }

  @ApiOperation({ summary: 'Reparto de propinas por horas y rol' })
  @RequirePermissions('attendance:read')
  @Get('tips')
  tips(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('weights') weights?: string,
  ) {
    return this.attendance.tipsDistribution(
      user.organizationId,
      branchId,
      from,
      to,
      weights,
    );
  }
}
