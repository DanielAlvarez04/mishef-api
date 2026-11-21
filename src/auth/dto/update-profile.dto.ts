import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message:
      'El usuario admite letras, números, punto, guion y guion bajo; sin @dominio',
  })
  username?: string;

  /** Nuevo correo; requiere verificación y desactiva 2FA hasta verificarlo. */
  @IsOptional()
  @IsEmail()
  email?: string;
}
