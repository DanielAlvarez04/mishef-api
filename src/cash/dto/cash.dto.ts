import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CashMovementType, CashSessionStatus } from '@prisma/client';

/** Apertura de caja con fondo inicial. */
export class OpenCashSessionDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  openingFloat?: number;
}

/** Cierre de caja con conteo ciego. */
export class CloseCashSessionDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  countedCash!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Retiro, ingreso o gasto de efectivo del turno. */
export class CashMovementDto {
  @IsEnum(CashMovementType)
  type!: CashMovementType;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  @IsString()
  @MaxLength(200)
  reason!: string;
}

/** Historial de turnos. */
export class ListCashSessionsQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsEnum(CashSessionStatus)
  status?: CashSessionStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}

/** Reporte de cobros por usuario. */
export class ChargesReportQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;
}
