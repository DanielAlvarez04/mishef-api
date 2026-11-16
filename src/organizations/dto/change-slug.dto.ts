import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class ChangeSlugDto {
  /** Nueva dirección del negocio (`mi-cafeteria`). */
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^[a-z0-9-]+$/, {
    message: 'Solo minúsculas, números y guiones',
  })
  slug!: string;
}
