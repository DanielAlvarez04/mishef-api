import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

export class UpdateUserDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  surname?: string;

  /** Nuevo usuario local. Único dentro del negocio. */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message:
      'El usuario admite letras, números, punto, guion y guion bajo; sin @dominio',
  })
  username?: string;

  /** Nuevo correo; se marca sin verificar y desactiva 2FA. */
  @IsOptional()
  @IsEmail()
  email?: string;

  /** Nueva contraseña; revoca las sesiones activas del usuario. */
  @IsOptional()
  @IsString()
  @MinLength(8)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'La contraseña debe incluir letras y números',
  })
  password?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsEnum(Role, { each: true })
  roles?: Role[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Sucursal principal; cadena vacía = acceso a todas las sucursales. */
  @IsOptional()
  @IsString()
  branchId?: string;
}
