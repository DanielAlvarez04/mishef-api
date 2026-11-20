import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Negocio en el que se abrirá la sesión de soporte. */
export class ImpersonateUserDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  organizationId!: string;
}
