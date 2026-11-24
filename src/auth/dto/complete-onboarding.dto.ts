import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CompleteOnboardingDto {
  /**
   * Dirección definitiva del negocio. Se guarda al terminar el asistente,
   * cuando el nombre del negocio ya es el correcto.
   */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  slug?: string;

  /** Nombre de la primera sucursal; se crea si aún no existe. */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  branchName?: string;
}
