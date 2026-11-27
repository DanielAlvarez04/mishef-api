import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
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
import {
  OrderChannel,
  OrderRoundStatus,
  GuestTitle,
  GuestSex,
  GuestAgeRange,
} from '@prisma/client';

/** Extra elegido para una línea (ej. "extra queso"). */
export class RoundItemExtraDto {
  @IsString()
  @MaxLength(40)
  extraId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  quantity?: number;
}

/** Opción elegida dentro de un grupo (ej. "Salsa roja"). */
export class RoundItemOptionDto {
  @IsString()
  @MaxLength(40)
  itemOptionValueId!: string;
}

/** Línea de una ronda: producto + variante + opciones + extras + exclusiones. */
export class RoundItemDto {
  @IsString()
  @MaxLength(40)
  itemId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  variantId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(99)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => RoundItemExtraDto)
  extras?: RoundItemExtraDto[];

  /** Opciones de los grupos configurados en el artículo. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RoundItemOptionDto)
  options?: RoundItemOptionDto[];

  /** Persona de la cuenta a la que pertenece esta línea (opcional). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  guestId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  excludedIngredientIds?: string[];
}

/** Envío de una ronda (comanda) a cocina. */
export class SendRoundDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RoundItemDto)
  items!: RoundItemDto[];

  /**
   * Clave de idempotencia del cliente. Reenviar la misma clave devuelve la
   * ronda ya creada en vez de duplicarla.
   */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;

  /** Mantener la ronda en espera (modo Avanzado, cursos). */
  @IsOptional()
  @IsBoolean()
  hold?: boolean;

  /** Curso al que pertenece la ronda (modo Avanzado). */
  @IsOptional()
  @IsString()
  courseId?: string;

  /**
   * Ronda de mostrador que se guarda sin enviar a cocina hasta confirmar el
   * pago. Solo aplica al canal COUNTER.
   */
  @IsOptional()
  @IsBoolean()
  paymentPending?: boolean;
}

export class UpdateOrderTablesDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  tableIds!: string[];
}

export class MergeOrdersDto {
  @IsString()
  sourceOrderId!: string;
}

/** Apertura de una cuenta (pedido). */
export class CreateOrderDto {
  /// Marca histórica; `channel` manda desde la caja nueva.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

  /** Mesas de la cuenta. La primera se usa como mesa principal. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  tableIds?: string[];

  @IsOptional()
  @IsBoolean()
  isTakeaway?: boolean;

  @IsOptional()
  @IsEnum(OrderChannel)
  channel?: OrderChannel;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  customerPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  deliveryAddress?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  deliveryFee?: number;

  @IsOptional()
  @IsDateString()
  scheduledAt?: string;

  /** Número de comensales de la mesa (1–20). */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  partySize?: number;

  /** Personas de la cuenta (opcional, para pedir por comensal). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderGuestDto)
  guests?: CreateOrderGuestDto[];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  idempotencyKey?: string;

  /**
   * Sincronización offline: si ya hay una cuenta abierta para la misma mesa,
   * devolverla en vez de abrir una segunda. Evita que dos dispositivos sin red
   * creen dos cuentas para la misma mesa.
   */
  @IsOptional()
  @IsBoolean()
  reuseOpenTable?: boolean;
}

/** Persona de la cuenta al abrirla. */
export class CreateOrderGuestDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @IsOptional()
  @IsEnum(GuestTitle)
  title?: GuestTitle | null;

  @IsOptional()
  @IsEnum(GuestSex)
  sex?: GuestSex | null;

  @IsOptional()
  @IsEnum(GuestAgeRange)
  ageRange?: GuestAgeRange | null;
}

/** Alta o edición de una persona de la cuenta. */
export class OrderGuestDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  name?: string;

  @IsOptional()
  @IsEnum(GuestTitle)
  title?: GuestTitle | null;

  @IsOptional()
  @IsEnum(GuestSex)
  sex?: GuestSex | null;

  @IsOptional()
  @IsEnum(GuestAgeRange)
  ageRange?: GuestAgeRange | null;
}

/** Ajuste del número de comensales en una sola operación. */
export class SetPartySizeDto {
  @IsInt()
  @Min(1)
  @Max(20)
  partySize!: number;
}

/** Transición de estado de una ronda. */
export class TransitionRoundDto {
  @IsEnum(OrderRoundStatus)
  status!: OrderRoundStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

/** Cancelación de una cuenta completa. */
export class CancelOrderDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
