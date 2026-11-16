import { IsString, MaxLength, MinLength } from 'class-validator';

export class SetDomainDto {
  /** Dominio propio que el negocio quiere conectar (`app.micafeteria.com`). */
  @IsString()
  @MinLength(4)
  @MaxLength(120)
  domain!: string;
}
