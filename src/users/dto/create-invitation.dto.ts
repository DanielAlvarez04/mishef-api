import { IsArray, IsEmail, IsEnum, IsOptional, IsString } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateInvitationDto {
  @IsEmail()
  email!: string;

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
