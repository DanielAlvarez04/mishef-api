import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { POINT_TERMINAL_MODELS } from '../point-terminal';

/** Actualización parcial de una terminal (solo los campos enviados). */
export class UpdateMercadoPagoTerminalDto {
  /** `null` desasigna la terminal de cualquier sucursal. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  branchId?: string | null;

  /** Modelo físico; permite saber si captura propina. */
  @IsOptional()
  @IsIn(POINT_TERMINAL_MODELS)
  model?: (typeof POINT_TERMINAL_MODELS)[number] | null;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
