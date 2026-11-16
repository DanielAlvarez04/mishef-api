import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  /** Correo electrónico de la cuenta. */
  @IsString()
  @MinLength(3)
  identifier!: string;

  @IsString()
  @MinLength(6)
  password!: string;

  /**
   * Dirección del negocio desde la que se entra (`micafeteria.mishef.co`).
   * Cuando llega, la cuenta debe pertenecer a esa organización: así el login
   * de un subdominio no deja entrar a usuarios de otro negocio.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  tenant?: string;
}
