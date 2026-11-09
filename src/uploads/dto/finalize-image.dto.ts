import { IsString, MinLength } from 'class-validator';

/** Clave temporal que devolvió `presign` y que el navegador acaba de subir. */
export class FinalizeImageDto {
  @IsString()
  @MinLength(1)
  key!: string;
}
