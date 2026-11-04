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
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OptionEffectAction, OptionSelection } from '@prisma/client';

/** Valor de la biblioteca de opciones (ej. "Salsa roja"). Sin precio. */
export class OptionValueInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  /** Texto que ve cocina; si falta se usa `name`. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  kitchenLabel?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class CreateOptionGroupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => OptionValueInputDto)
  values?: OptionValueInputDto[];
}

export class UpdateOptionGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateOptionValueDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  kitchenLabel?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Efecto de una opción sobre la receta (solo recetas publicadas). */
export class ItemOptionEffectInputDto {
  @IsEnum(OptionEffectAction)
  action!: OptionEffectAction;

  /** Slot de la receta a reemplazar o quitar (null en ADD). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  recipeIngredientId?: string;

  /** Insumo que entra (REPLACE/ADD) o que se quita (REMOVE por insumo). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  ingredientId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  quantity?: number;
}

/** Valor del grupo aplicado a un artículo: precio, default y efectos. */
export class ItemOptionValueInputDto {
  /** Valor de la biblioteca. Excluyente con `customName`. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  valueId?: string;

  /**
   * Opción propia del artículo. No modifica el grupo de la biblioteca.
   * Excluyente con `valueId`.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  customName?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  priceDelta?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(40)
  @ValidateNested({ each: true })
  @Type(() => ItemOptionEffectInputDto)
  effects?: ItemOptionEffectInputDto[];
}

export class ItemOptionGroupInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  groupId!: string;

  @IsOptional()
  @IsBoolean()
  isRequired?: boolean;

  @IsOptional()
  @IsEnum(OptionSelection)
  selection?: OptionSelection;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  minSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(50)
  maxSelect?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(60)
  @ValidateNested({ each: true })
  @Type(() => ItemOptionValueInputDto)
  values!: ItemOptionValueInputDto[];
}

/** Activa/desactiva los grupos de opciones core sugeridos. */
export class UpdateCoreOptionGroupStatusDto {
  @IsBoolean()
  isActive!: boolean;
}
