import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ShiftBreakType } from '@prisma/client';

import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { JwtUser } from '../auth/auth.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentBranch } from '../common/decorators/current-branch.decorator';
import { RequirePermissions } from '../common/decorators/require-permissions.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AttendanceService } from './attendance.service';
import {
  AttendanceAdjustmentDto,
  AttendanceQueryDto,
  ClockInDto,
  ClockOutDto,
  CopyScheduleDto,
  KioskPunchDto,
  ReviewShiftDto,
  SaveScheduleDto,
  ScheduleTemplateDto,
  ScheduleWeekDto,
  SetKioskOperatorsDto,
  StartBreakDto,
  UpdateAttendanceSettingsDto,
} from './dto/attendance.dto';

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

  @ApiOperation({ summary: 'Resumen personal de asistencia, horario y propinas' })
  @RequirePermissions('attendance:clock')
  @Get('me')
  me(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.attendance.me(user.organizationId, user.sub, branchId);
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
      {
        latitude: dto.latitude,
        longitude: dto.longitude,
        idempotencyKey: dto.idempotencyKey,
      },
    );
  }

  @ApiOperation({ summary: 'Marcar salida' })
  @RequirePermissions('attendance:clock')
  @HttpCode(200)
  @Post('clock-out')
  clockOut(
    @CurrentUser() user: JwtUser,
    @Body() dto: ClockOutDto,
  ) {
    return this.attendance.clockOut(
      user.organizationId,
      user.sub,
      dto.note,
      {
        latitude: dto.latitude,
        longitude: dto.longitude,
        idempotencyKey: dto.idempotencyKey,
      },
    );
  }

  @ApiOperation({ summary: 'Iniciar comida o descanso' })
  @RequirePermissions('attendance:clock')
  @HttpCode(201)
  @Post('breaks/start')
  startBreak(
    @CurrentUser() user: JwtUser,
    @Body() dto: StartBreakDto,
  ) {
    return this.attendance.startBreak(
      user.organizationId,
      user.sub,
      dto.type ?? ShiftBreakType.LUNCH,
      dto.note,
      {
        latitude: dto.latitude,
        longitude: dto.longitude,
        idempotencyKey: dto.idempotencyKey,
      },
    );
  }

  @ApiOperation({ summary: 'Terminar comida o descanso' })
  @RequirePermissions('attendance:clock')
  @HttpCode(200)
  @Post('breaks/end')
  endBreak(
    @CurrentUser() user: JwtUser,
    @Body() dto: ClockOutDto,
  ) {
    return this.attendance.endBreak(
      user.organizationId,
      user.sub,
      dto.note,
      {
        latitude: dto.latitude,
        longitude: dto.longitude,
        idempotencyKey: dto.idempotencyKey,
      },
    );
  }

  @ApiOperation({ summary: 'Configuración de tolerancias' })
  @RequirePermissions('attendance:read')
  @Get('settings')
  settings(@CurrentUser() user: JwtUser) {
    return this.attendance.getSettings(user.organizationId);
  }

  @ApiOperation({ summary: 'Actualizar tolerancias (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Patch('settings')
  updateSettings(
    @CurrentUser() user: JwtUser,
    @Body() dto: UpdateAttendanceSettingsDto,
  ) {
    return this.attendance.updateSettings(
      user.organizationId,
      user.sub,
      dto,
    );
  }

  @ApiOperation({ summary: 'Horario semanal y equipo (ADMIN/CAJA)' })
  @RequirePermissions('attendance:read')
  @Get('schedule')
  schedule(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query('weekStart') weekStart?: string,
  ) {
    return this.attendance.scheduleWeek(
      user.organizationId,
      branchId,
      weekStart ?? new Date().toISOString().slice(0, 10),
    );
  }

  @ApiOperation({ summary: 'Guardar borrador de horario (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Put('schedule')
  saveSchedule(@CurrentUser() user: JwtUser, @Body() dto: SaveScheduleDto) {
    return this.attendance.saveSchedule(user.organizationId, user.sub, dto);
  }

  @ApiOperation({ summary: 'Publicar horario (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Post('schedule/publish')
  publishSchedule(
    @CurrentUser() user: JwtUser,
    @Body() dto: ScheduleWeekDto,
  ) {
    return this.attendance.publishSchedule(
      user.organizationId,
      user.sub,
      dto,
    );
  }

  @ApiOperation({ summary: 'Copiar horario de otra semana (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Post('schedule/copy')
  copySchedule(@CurrentUser() user: JwtUser, @Body() dto: CopyScheduleDto) {
    return this.attendance.copySchedule(user.organizationId, user.sub, dto);
  }

  @ApiOperation({ summary: 'Plantillas de horario' })
  @RequirePermissions('attendance:read')
  @Get('templates')
  templates(@CurrentUser() user: JwtUser) {
    return this.attendance.templates(user.organizationId);
  }

  @ApiOperation({ summary: 'Crear plantilla de horario (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Post('templates')
  createTemplate(
    @CurrentUser() user: JwtUser,
    @Body() dto: ScheduleTemplateDto,
  ) {
    return this.attendance.createTemplate(
      user.organizationId,
      user.sub,
      dto,
    );
  }

  @ApiOperation({ summary: 'Editar plantilla de horario (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Patch('templates/:id')
  updateTemplate(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ScheduleTemplateDto,
  ) {
    return this.attendance.updateTemplate(
      user.organizationId,
      user.sub,
      id,
      dto,
    );
  }

  @ApiOperation({ summary: 'Desactivar plantilla de horario (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Delete('templates/:id')
  deleteTemplate(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.attendance.deleteTemplate(user.organizationId, user.sub, id);
  }

  @ApiOperation({ summary: 'Cuentas habilitadas para el checador' })
  @RequirePermissions('attendance:read')
  @Get('kiosk-operators')
  kioskOperators(@CurrentUser() user: JwtUser) {
    return this.attendance.listKioskOperators(user.organizationId);
  }

  @ApiOperation({ summary: 'Habilitar cuentas para el checador (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Put('kiosk-operators')
  setKioskOperators(
    @CurrentUser() user: JwtUser,
    @Body() dto: SetKioskOperatorsDto,
  ) {
    return this.attendance.setKioskOperators(
      user.organizationId,
      user.sub,
      dto,
    );
  }

  @ApiOperation({ summary: 'Cuentas activas para el checador' })
  @RequirePermissions('attendance:clock')
  @Get('kiosk')
  kiosk(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.attendance.kiosk(user.organizationId, branchId, user.sub);
  }

  @ApiOperation({ summary: 'Registrar checada desde una cuenta checadora' })
  @RequirePermissions('attendance:clock')
  @Post('kiosk/punch')
  kioskPunch(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Body() dto: KioskPunchDto,
  ) {
    return this.attendance.kioskPunch(
      user.organizationId,
      branchId,
      user.sub,
      dto,
    );
  }

  @ApiOperation({ summary: 'Mi parte del reparto de propinas' })
  @RequirePermissions('attendance:clock')
  @Get('tips/me')
  myTips(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
  ) {
    return this.attendance.myTips(user.organizationId, branchId, user.sub);
  }

  @ApiOperation({ summary: 'Turnos del equipo en el periodo' })
  @RequirePermissions('attendance:read')
  @Get()
  list(
    @CurrentUser() user: JwtUser,
    @CurrentBranch() branchId: string | null,
    @Query() query: AttendanceQueryDto,
  ) {
    return this.attendance.list(
      user.organizationId,
      query.branchId ?? branchId,
      query.from,
      query.to,
    );
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

  @ApiOperation({ summary: 'Agregar minutos u horas extra (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Post(':id/adjustments')
  adjust(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: AttendanceAdjustmentDto,
  ) {
    return this.attendance.adjust(user.organizationId, user.sub, id, dto);
  }

  @ApiOperation({ summary: 'Cuadrar horas faltantes contra el horario (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Post(':id/square')
  square(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.attendance.square(user.organizationId, user.sub, id);
  }

  @ApiOperation({ summary: 'Autorizar una checada fuera de zona (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Post(':id/review')
  review(
    @CurrentUser() user: JwtUser,
    @Param('id') id: string,
    @Body() dto: ReviewShiftDto,
  ) {
    return this.attendance.review(user.organizationId, user.sub, id, dto);
  }

  @ApiOperation({ summary: 'Log inmutable de un turno (ADMIN)' })
  @RequirePermissions('attendance:manage')
  @Get(':id/events')
  events(@CurrentUser() user: JwtUser, @Param('id') id: string) {
    return this.attendance.events(user.organizationId, id);
  }
}
