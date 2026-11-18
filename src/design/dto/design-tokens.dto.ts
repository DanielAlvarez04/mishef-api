import { IsObject } from 'class-validator';

/** Tokens visuales globales (colores, radios y bordes). */
export class UpdateDesignTokensDto {
  @IsObject()
  tokens!: Record<string, unknown>;
}
