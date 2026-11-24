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
}
