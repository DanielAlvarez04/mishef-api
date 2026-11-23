import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { UnitCode } from '@prisma/client';

export class CreateSupplierDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  rfc?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  defaultTaxRate?: number;
}

export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  rfc?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @IsString({ each: true })
  aliases?: string[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  defaultTaxRate?: number | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateSupplierProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  rawName!: string;

  @IsOptional()
  @IsString()
  ingredientId?: string;

  /** Cuánto del ingrediente aporta una unidad del producto del proveedor. */
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;

  @IsEnum(UnitCode)
  unit!: UnitCode;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  lastUnitCostGross?: number;
}
