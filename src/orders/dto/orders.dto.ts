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
import { OrderChannel, OrderRoundStatus, GuestTitle } from '@prisma/client';

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
}

/** Apertura de una cuenta (pedido). */
export class CreateOrderDto {
  /// Marca histórica; `channel` manda desde la caja nueva.
  @IsOptional()
  @IsString()
  @MaxLength(20)
  tableNumber?: string;

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
