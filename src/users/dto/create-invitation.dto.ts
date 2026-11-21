import {
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Role } from '@prisma/client';

export class CreateInvitationDto {
  @IsEmail()
  email!: string;

  /** Nombre visible con el que se creará la cuenta. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  /** Username local que tendrá al aceptar. */
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-zA-Z0-9._-]+$/, {
    message: 'El usuario admite letras, números, punto, guion y guion bajo',
  })
  username?: string;

  /** Roles que tendrá la persona al aceptar. Por defecto, mesero. */
  @IsOptional()
  @IsArray()
  @IsEnum(Role, { each: true })
  roles?: Role[];

  /** Sucursal a la que queda limitada. `null` = todas. */
  @IsOptional()
  @IsString()
  branchId?: string;
}
