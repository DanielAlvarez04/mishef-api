import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Actualización parcial de una terminal (solo los campos enviados). */
export class UpdateMercadoPagoTerminalDto {
  /** `null` desasigna la terminal de cualquier sucursal. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  branchId?: string | null;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
