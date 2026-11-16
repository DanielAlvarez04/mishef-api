import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  /** Nombre del negocio que se creará con esta cuenta. */
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  organizationName?: string;

  /**
   * Token de Cloudflare Turnstile. Obligatorio cuando la API tiene
   * `TURNSTILE_SECRET` configurado; sin la variable se ignora.
   */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;

  /**
   * Dirección del negocio (`micafeteria`). Se convierte en el subdominio
   * `micafeteria.mishef.co`. Si se omite, se genera una con sufijo aleatorio.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  slug?: string;
}
