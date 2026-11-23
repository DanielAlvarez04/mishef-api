import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { CategoryKind } from '@prisma/client';

export class CreateCategoryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  /** Token del catálogo de colores (`red-400`, `sky-600`). */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z]+-(200|400|600|800)$/, {
    message: 'El color debe ser un tono permitido (p. ej. red-400)',
  })
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /** Las categorías de artículos son el valor por defecto. */
  @IsOptional()
  @IsEnum(CategoryKind)
  kind?: CategoryKind;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  description?: string;

  /** Token del catálogo de colores (`red-400`, `sky-600`). */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z]+-(200|400|600|800)$/, {
    message: 'El color debe ser un tono permitido (p. ej. red-400)',
  })
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Activar/desactivar todas las categorías core de un tipo. */
export class UpdateCoreCategoryGroupDto {
  @IsEnum(CategoryKind)
  kind!: CategoryKind;

  @IsBoolean()
  isActive!: boolean;
}
