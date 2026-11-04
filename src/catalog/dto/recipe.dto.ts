import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { UnitCode } from '@prisma/client';

/** Alternativa de un ingrediente (ej. leche deslactosada, de coco). */
export class RecipeIngredientOptionInputDto {
  @IsString()
  @MinLength(1)
  ingredientId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  quantity!: number;

  /** Unidad de la cantidad; si se omite se interpreta en la unidad base. */
  @IsOptional()
  @IsEnum(UnitCode)
  unit?: UnitCode;
}

export class RecipeIngredientInputDto {
  /** Insumo default del slot. */
  @IsString()
  @MinLength(1)
  ingredientId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  quantity!: number;

  @IsOptional()
  @IsEnum(UnitCode)
  unit?: UnitCode;

  /** Presentación a la que aplica el insumo; omitido/null = común. */
  @IsOptional()
  @IsString()
  variantId?: string | null;

  /** Nombre del slot ("Leche"); si falta se usa el del insumo default. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;

  @IsOptional()
  @IsBoolean()
  isOptional?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientOptionInputDto)
  alternatives?: RecipeIngredientOptionInputDto[];
}

export class RecipeVariantInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  priceAdjust?: number;

  /** Multiplicador de consumo; Regular = 1. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @IsPositive()
  recipeFactor?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Publicar la receta como artículo vendible. */
export class PublishRecipeDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'El SKU solo admite letras, números, punto, guion y guion bajo',
  })
  sku?: string;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  /** Tasa de IVA como fracción (0.16 = 16 %). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  taxRate?: number | null;

  /** Presentaciones; si se omite se crean Chico, Regular y Grande. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => RecipeVariantInputDto)
  variants?: RecipeVariantInputDto[];
}

/** Convertir la receta en un insumo del inventario. */
export class RecipeProductionInputDto {
  /** Unidad visible con la que se produce el insumo. */
  @IsEnum(UnitCode)
  displayUnit!: UnitCode;

  /** Rendimiento del lote en `displayUnit`. */
  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  yieldQuantity!: number;
}

export class CreateRecipeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Artículo existente al que se vincula la receta (crear la receta desde el
   * diálogo unificado del artículo). Si llega, no se publica un artículo nuevo.
   */
  @IsOptional()
  @IsString()
  itemId?: string;

  /** Presentación concreta del artículo; null/omitido = receta base. */
  @IsOptional()
  @IsString()
  variantId?: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientInputDto)
  ingredients?: RecipeIngredientInputDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PublishRecipeDto)
  publish?: PublishRecipeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecipeProductionInputDto)
  produce?: RecipeProductionInputDto;
}

export class UpdateRecipeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Clave en R2 de la imagen propia de la receta; `null` la quita. */
  @IsOptional()
  @IsString()
  imageKey?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientInputDto)
  ingredients?: RecipeIngredientInputDto[];

  @IsOptional()
  @ValidateNested()
  @Type(() => PublishRecipeDto)
  publish?: PublishRecipeDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => RecipeProductionInputDto)
  produce?: RecipeProductionInputDto;

  /** Desvincula el insumo producido (apagar el switch «Insumo»). */
  @IsOptional()
  @IsBoolean()
  clearProduce?: boolean;
}

export class ProduceRecipeDto {
  /** Cantidad producida; si se omite se usa el rendimiento de la receta. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @IsPositive()
  quantity?: number;

  @IsOptional()
  @IsEnum(UnitCode)
  unit?: UnitCode;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

// Compatibilidad con el editor anterior por producto/variante.
export class UpsertRecipeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  variantId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RecipeIngredientInputDto)
  ingredients!: RecipeIngredientInputDto[];
}
