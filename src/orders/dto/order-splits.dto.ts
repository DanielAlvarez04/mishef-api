import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { SplitMode } from '@prisma/client';

export class OrderSplitAmountDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  label?: string;

  @IsOptional()
  @IsString()
  guestId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;
}

/** División de una cuenta para cobrarla por partes. */
export class CreateOrderSplitDto {
  @IsEnum(SplitMode)
  mode!: SplitMode;

  /** Número de partes para el modo EQUAL (2–20). */
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(20)
  parts?: number;

  /** Partes explícitas para el modo CUSTOM. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => OrderSplitAmountDto)
  amounts?: OrderSplitAmountDto[];
}
