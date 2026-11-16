import { IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { UnitCode, WasteReason } from '@prisma/client';

const DECIMAL_PATTERN = /^-?\d+(\.\d{1,6})?$/;

export class CreateWasteDto {
  @IsString()
  @MinLength(1)
  ingredientId!: string;

  /** Cantidad en la unidad indicada (positiva). */
  @IsString()
  @Matches(DECIMAL_PATTERN, {
    message: 'La cantidad debe ser un número decimal (máx. 6 decimales)',
  })
  quantity!: string;

  /** Unidad de captura. Por defecto, la visible del insumo. */
  @IsOptional()
  @IsEnum(UnitCode)
  unit?: UnitCode;

  @IsEnum(WasteReason)
  reason!: WasteReason;

  @IsOptional()
  @IsString()
  @MaxLength(280)
  note?: string;

  /** Clave del objeto subido con `POST /waste/photo`. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  photoKey?: string;
}

export class PresignWastePhotoDto {
  @IsString()
  @MaxLength(60)
  contentType!: string;

  /** Tamaño del archivo en bytes (lo conoce el navegador). */
  @IsOptional()
  @IsInt()
  @Min(1)
  size?: number;
}
