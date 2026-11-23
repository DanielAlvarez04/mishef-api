import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { UnitCode } from '@prisma/client';

export class PresignTicketDto {
  @IsString()
  @MaxLength(80)
  contentType!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  size?: number;
}

export class CreateTicketDto {
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  documentKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  documentMime?: string;

  @IsOptional()
  @IsString()
  supplierId?: string;

  @IsOptional()
  @IsISO8601()
  purchasedAt?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  total?: number;
}

export class PurchaseItemDto {
  @IsOptional()
  @IsString()
  id?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  rawDescription!: string;

  @IsOptional()
  @IsString()
  ingredientId?: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;

  @IsEnum(UnitCode)
  unit!: UnitCode;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  unitCostGross!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  lineTotalGross!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  confidence?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  mappingSource?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  taxRate?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxAmount?: number;
}

export class ReviewPurchaseDto {
  @IsOptional()
  @IsString()
  supplierId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  folio?: string | null;

  @IsOptional()
  @IsISO8601()
  purchasedAt?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  total?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => PurchaseItemDto)
  items?: PurchaseItemDto[];
}

export class RejectPurchaseDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
