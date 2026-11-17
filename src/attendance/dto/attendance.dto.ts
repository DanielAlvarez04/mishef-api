import { ShiftBreakType } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ClockInDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;
}

export class ClockOutDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;
}

export class StartBreakDto extends ClockInDto {
  @IsEnum(ShiftBreakType)
  type!: ShiftBreakType;
}

export enum PunchAction {
  CLOCK_IN = 'CLOCK_IN',
  LUNCH_START = 'LUNCH_START',
  LUNCH_END = 'LUNCH_END',
  CLOCK_OUT = 'CLOCK_OUT',
}

/** Checada hecha por una cuenta habilitada como checador. */
export class KioskPunchDto {
  @IsString()
  @MaxLength(40)
  userId!: string;

  @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener de 4 a 8 dígitos' })
  pin!: string;

  @IsEnum(PunchAction)
  action!: PunchAction;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;

  @IsOptional()
  @IsNumber()
  latitude?: number;

  @IsOptional()
  @IsNumber()
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;
}

export class UpdateAttendanceSettingsDto {
  @IsOptional()
  @IsBoolean()
  applyTolerance?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  lateGraceMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  lunchGraceMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  earlyLeaveGraceMinutes?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  defaultBreakMinutes?: number;
}

export class ScheduleEntryInputDto {
  @IsString()
  @MaxLength(40)
  userId!: string;

  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'La fecha debe ser YYYY-MM-DD',
  })
  date!: string;

  @Matches(/^\d{2}:\d{2}$/, { message: 'La entrada debe ser HH:mm' })
  startTime!: string;

  @Matches(/^\d{2}:\d{2}$/, { message: 'La salida debe ser HH:mm' })
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  breakMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

export class SaveScheduleDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La semana debe ser YYYY-MM-DD' })
  weekStart!: string;

  @IsOptional()
  @IsString()
  branchId?: string | null;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ScheduleEntryInputDto)
  entries!: ScheduleEntryInputDto[];
}

export class ScheduleWeekDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La semana debe ser YYYY-MM-DD' })
  weekStart!: string;

  @IsOptional()
  @IsString()
  branchId?: string | null;
}

export class CopyScheduleDto extends ScheduleWeekDto {
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'La semana debe ser YYYY-MM-DD' })
  fromWeekStart!: string;
}

export class ScheduleTemplateDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @Matches(/^\d{2}:\d{2}$/, { message: 'La entrada debe ser HH:mm' })
  startTime!: string;

  @Matches(/^\d{2}:\d{2}$/, { message: 'La salida debe ser HH:mm' })
  endTime!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(240)
  breakMinutes?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  color?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class SetKioskOperatorsDto {
  @IsArray()
  @IsString({ each: true })
  userIds!: string[];
}

export class AttendanceAdjustmentDto {
  @IsInt()
  @Min(1)
  @Max(24 * 60)
  minutes!: number;

  @IsString()
  @Min(3)
  @MaxLength(300)
  reason!: string;
}

export class ReviewShiftDto {
  @IsBoolean()
  approve!: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class AttendanceQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  branchId?: string;
}
