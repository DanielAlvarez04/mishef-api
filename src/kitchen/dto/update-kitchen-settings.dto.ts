import { IsBoolean, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { PrepTimeSource } from '@prisma/client';
import { MAX_PREP_MINUTES, MIN_PREP_MINUTES } from '../../common/prep';

export class UpdateKitchenSettingsDto {
  /** Tiempo manual por defecto, en minutos. */
  @IsOptional()
  @IsInt()
  @Min(MIN_PREP_MINUTES)
  @Max(MAX_PREP_MINUTES)
  prepMinutes?: number;

  /** Manual o promedio histórico real. */
  @IsOptional()
  @IsEnum(PrepTimeSource)
  source?: PrepTimeSource;

  /** Ordenar la cola de cocina por urgencia. */
  @IsOptional()
  @IsBoolean()
  suggestOrder?: boolean;
}
