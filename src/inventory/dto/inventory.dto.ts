import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { UnitCode } from '@prisma/client';

export class ImportIngredientRowDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsEnum(UnitCode)
  displayUnit?: UnitCode;

  /** Obligatoria: el SKU se deriva del prefijo de la categoría. */
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  maxStock?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  currentStock?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  minStock?: number;
}

const DECIMAL_PATTERN = /^-?\d{1,9}(\.\d{1,6})?$/;

export class IngredientPosPresentationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;
}

export class IngredientPosDto {
  /** Nombre del artículo en el POS; si falta se usa el del insumo. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => IngredientPosPresentationDto)
  presentations?: IngredientPosPresentationDto[];
}

export class CreateIngredientDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /**
   * Unidad con la que el usuario captura las cantidades. Se guarda como
   * `displayUnit` y las cantidades de este DTO se interpretan en ella.
   */
  @IsOptional()
  @IsEnum(UnitCode)
  displayUnit?: UnitCode;

  /** Obligatoria: el SKU se deriva del prefijo de la categoría. */
  @IsString()
  @IsNotEmpty()
  categoryId!: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  minStock?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  maxStock?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  unitCost?: number;

  /** Stock inicial (se registra como movimiento de ajuste auditable). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  currentStock?: number;

  /** Publica el insumo como artículo vendible en el POS. */
  @IsOptional()
  @ValidateNested()
  @Type(() => IngredientPosDto)
  pos?: IngredientPosDto;
}

export class CreateIngredientsBulkDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => CreateIngredientDto)
  ingredients!: CreateIngredientDto[];
}

export class DeleteIngredientsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsString({ each: true })
  ids!: string[];

  /**
   * Subconjunto de `ids` que pertenece al catálogo core. Al eliminarlos, las
   * recetas que los usan quedan inactivas en lugar de bloquear el borrado.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  coreIds?: string[];
}

/** Producto del catálogo core que se quiere tener en el inventario. */
export class SyncCoreItemDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** Unidad sugerida; se guarda como unidad visible del insumo. */
  @IsEnum(UnitCode)
  displayUnit!: UnitCode;

  @IsString()
  @IsNotEmpty()
  category!: string;

  @IsString()
  @IsNotEmpty()
  location!: string;
}

export class SyncCoreItemsDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => SyncCoreItemDto)
  items!: SyncCoreItemDto[];

  /** Nombres del catálogo que el usuario dejó desmarcados. */
  @IsArray()
  @ArrayMaxSize(300)
  @IsString({ each: true })
  removeNames!: string[];

  /**
   * Igual que `removeNames`, pero con los datos del preset para validar que el
   * insumo no haya sido modificado antes de desactivarlo.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(300)
  @ValidateNested({ each: true })
  @Type(() => SyncCoreItemDto)
  removeItems?: SyncCoreItemDto[];
}

/** Activar/desactivar todas las categorías core de inventario. */
export class UpdateCoreIngredientCategoriesDto {
  @IsBoolean()
  isActive!: boolean;
}

export class UpdateIngredientDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsEnum(UnitCode)
  displayUnit?: UnitCode;

  /**
   * Cambiar de categoría regenera el SKU con el prefijo de la nueva categoría.
   * El SKU nunca se edita directamente.
   */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  categoryId?: string;

  @IsOptional()
  @IsString()
  locationId?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  minStock?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  maxStock?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  unitCost?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateAdjustmentDto {
  @IsString()
  @MinLength(1)
  ingredientId!: string;

  /**
   * Cantidad con signo en la unidad base del ingrediente (o en `unit`).
   * Positivo = entrada, negativo = salida.
   */
  @IsString()
  @Matches(DECIMAL_PATTERN, {
    message: 'La cantidad debe ser un número decimal (máx. 6 decimales)',
  })
  quantity!: string;

  @IsOptional()
  @IsEnum(UnitCode)
  unit?: UnitCode;

  @IsString()
  @MinLength(3)
  @MaxLength(280)
  reason!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  referenceId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  referenceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  dedupeKey?: string;

  /**
   * Costo por unidad visible al registrar una entrada (compra). Opcional: si
   * llega, actualiza el costo del insumo y queda guardado en el movimiento.
   */
  @IsOptional()
  @IsString()
  @Matches(DECIMAL_PATTERN, {
    message: 'El costo debe ser un número decimal (máx. 6 decimales)',
  })
  unitCost?: string;
}

export class CreateEquivalenceDto {
  @IsEnum(UnitCode)
  fromUnit!: UnitCode;

  @IsEnum(UnitCode)
  toUnit!: UnitCode;

  /** 1 `fromUnit` = `factor` `toUnit`. */
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001)
  factor!: number;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;
}
