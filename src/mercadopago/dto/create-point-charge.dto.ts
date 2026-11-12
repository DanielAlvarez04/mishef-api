import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
} from 'class-validator';

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
}
