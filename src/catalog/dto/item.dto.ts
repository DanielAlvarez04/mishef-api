import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
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
import { UnitCode, PromotionType } from '@prisma/client';
import { ItemOptionGroupInputDto } from './option.dto';

export class CreateVariantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  priceAdjust?: number;

  /** Multiplicador del consumo de la receta base (Regular = 1). */
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

  /** Presentación que el menú muestra por defecto (solo una por artículo). */
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class UpdateVariantDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  priceAdjust?: number;

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

  /** Presentación que el menú muestra por defecto (solo una por artículo). */
  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;
}

export class ExtraIngredientInputDto {
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

export class CreateExtraDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ExtraIngredientInputDto)
  ingredients?: ExtraIngredientInputDto[];
}

export class UpdateExtraDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Si se envía, reemplaza el consumo de inventario del extra. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ExtraIngredientInputDto)
  ingredients?: ExtraIngredientInputDto[];
}

export class ExclusionInputDto {
  @IsString()
  @MinLength(1)
  ingredientId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  label?: string;
}

export class ComboComponentInputDto {
  @IsString()
  @MinLength(1)
  itemId!: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  variantId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(999)
  quantity?: number;
}

/** Promoción de un combo: descuento, 2x1 o vigencia por horario. */
export class ComboPromotionInputDto {
  @IsOptional()
  @IsString()
  @MaxLength(80)
  name?: string;

  @IsEnum(PromotionType)
  type!: PromotionType;

  /** Porcentaje (0-100) o importe fijo en MXN. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  value?: number;

  /** Para PAY_X_GET_Y: cantidad que paga y cantidad que recibe. */
  @IsOptional()
  @IsInt()
  @Min(1)
  payQuantity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  getQuantity?: number;

  /** Para SPECIAL_PRICE: precio final del combo. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  specialPrice?: number;

  /** Para FREE_ITEM: presentación del combo que sale gratis. */
  @IsOptional()
  @IsString()
  freeItemId?: string | null;

  @IsOptional()
  @IsString()
  freeVariantId?: string | null;

  /** Para SECOND_HALF_PRICE: presentación a la que se aplica el 50 %. */
  @IsOptional()
  @IsString()
  discountedItemId?: string | null;

  @IsOptional()
  @IsString()
  discountedVariantId?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateItemDto {
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
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'El SKU solo admite letras, números, punto, guion y guion bajo',
  })
  sku?: string;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;
  /** Tasa de IVA como fracción (0.16 = 16 %). Nunca se asume una por defecto. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  taxRate?: number | null;

  @IsOptional()
  @IsBoolean()
  isCombo?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants?: CreateVariantDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => CreateExtraDto)
  extras?: CreateExtraDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ExclusionInputDto)
  exclusions?: ExclusionInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ComboComponentInputDto)
  comboComponents?: ComboComponentInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ItemOptionGroupInputDto)
  optionGroups?: ItemOptionGroupInputDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ComboPromotionInputDto)
  promotions?: ComboPromotionInputDto[];
}

export class UpdateItemDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[A-Za-z0-9._-]+$/, {
    message: 'El SKU solo admite letras, números, punto, guion y guion bajo',
  })
  sku?: string | null;

  /** Clave del objeto en R2; `null` quita la imagen del artículo. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  imageKey?: string | null;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  taxRate?: number | null;

  @IsOptional()
  @IsBoolean()
  isCombo?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /** Presentaciones a sincronizar (por nombre). Las faltantes se desactivan. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants?: CreateVariantDto[];

  /** Configuración completa de grupos de opciones del artículo. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ItemOptionGroupInputDto)
  optionGroups?: ItemOptionGroupInputDto[];

  /** Promociones del combo; reemplaza la lista completa. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ComboPromotionInputDto)
  promotions?: ComboPromotionInputDto[];
}

export class DeleteItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids!: string[];
}

export class ReplaceExclusionsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ExclusionInputDto)
  exclusions!: ExclusionInputDto[];
}

export class ReplaceComboComponentsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ComboComponentInputDto)
  components!: ComboComponentInputDto[];
}

export class ReplaceComboPromotionsDto {
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => ComboPromotionInputDto)
  promotions!: ComboPromotionInputDto[];
}
