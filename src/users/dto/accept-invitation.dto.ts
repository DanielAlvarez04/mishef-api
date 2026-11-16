import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AcceptInvitationDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  /**
   * Contraseña para la cuenta nueva. Si el correo ya tiene cuenta en Mishef,
   * se ignora: basta con iniciar sesión después.
   */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password?: string;
}
