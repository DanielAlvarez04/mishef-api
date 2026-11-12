import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreatePosPairingDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  branchId?: string;
}

export class ClaimPosPairingDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;
}

export class PosPinLoginDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  userId!: string;

  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 dígitos' })
  pin!: string;
}

export class SetPosPinDto {
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'El PIN debe tener entre 4 y 8 dígitos' })
  pin!: string;
}

export class CreatePosDisplayDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  branchId?: string;
}

export class PosDisplayItemDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;
}

export class UpdatePosDisplayStateDto {
  @IsString()
  @MaxLength(80)
  sessionKey!: string;

  @IsArray()
  @ArrayMaxSize(80)
  @ValidateNested({ each: true })
  @Type(() => PosDisplayItemDto)
  items!: PosDisplayItemDto[];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  total!: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;
}

export class PosDisplayTipDto {
  @IsNumber({ maxDecimalPlaces: 0 })
  @Min(0)
  @Max(100)
  tipPercent!: number;
}
