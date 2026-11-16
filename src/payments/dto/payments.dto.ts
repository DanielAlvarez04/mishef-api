import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { PaymentMethod, PaymentStatus, TipSource } from '@prisma/client';

/** Registro de un pago (queda PENDIENTE hasta que se confirme). */
export class CreatePaymentDto {
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  amount!: number;

  /** Propina opcional, separada del importe de la venta. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tipAmount?: number;

  /** Porcentaje de propina aplicado (0–100). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  tipPercent?: number | null;

  /** Origen de la propina: sugerida, manual o pantalla del cliente. */
  @IsOptional()
  @IsEnum(TipSource)
  tipSource?: TipSource;

  /** Base sobre la que se calculó el porcentaje de propina. */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  tipBaseAmount?: number | null;

  /** Parte de la cuenta a la que se aplica el pago. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  splitId?: string;

  /**
   * Registra y confirma el pago en la misma petición.
   *
   * Solo se permite a roles con `payments:confirm`; el controlador lo valida.
   */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;

  /** Quién recibe la propina; por defecto, quien cobra. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tipRecipientId?: string;

  /** Efectivo entregado por el cliente (solo efectivo). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  cashReceived?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  changeGiven?: number;

  /**
   * Clave de idempotencia del cliente. Reenviar la misma clave devuelve el
   * pago ya registrado en vez de duplicarlo.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;
}

/** Anulación de un pago pendiente o devolución de uno confirmado. */
export class VoidPaymentDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** Filtros de la caja (listado de pagos). */
export class ListPaymentsQueryDto {
  @IsOptional()
  @IsString()
  from?: string;

  @IsOptional()
  @IsString()
  to?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  offset?: number;
}
