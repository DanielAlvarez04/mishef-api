import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { TipSource } from '@prisma/client';

/** Cobro enviado a una terminal Mercado Pago Point. */
export class CreatePointChargeDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(99_999_999)
  amount!: number;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  terminalId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;

  /** Parte de la cuenta a la que se aplica el cobro, si está dividida. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  splitId?: string;

  /**
   * Propina incluida en el mismo cobro de la terminal.
   *
   * La terminal cobra `amount + tipAmount`, pero en la base la venta y la
   * propina quedan separadas para que el saldo de la cuenta no cambie.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tipAmount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  tipPercent?: number | null;

  @IsOptional()
  @IsEnum(TipSource)
  tipSource?: TipSource;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tipBaseAmount?: number | null;
}
