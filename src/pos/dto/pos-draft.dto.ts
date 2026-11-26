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
} from 'class-validator';
import { OrderChannel, GuestAgeRange, GuestSex } from '@prisma/client';

/** Captura que el POS guarda como borrador sin enviar a cocina. */
export class CreatePosDraftDto {
  /** Cuenta abierta de la que sale la captura, si aplica. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  orderId?: string;

  @IsOptional()
  @IsEnum(OrderChannel)
  channel?: OrderChannel;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  tableNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  tableId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  customerName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  customerPhone?: string;

  @IsOptional()
  @IsEnum(GuestSex)
  customerSex?: GuestSex | null;

  @IsOptional()
  @IsEnum(GuestAgeRange)
  customerAgeRange?: GuestAgeRange | null;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  deliveryAddress?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  deliveryFee?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  partySize?: number;

  /** Líneas del carrito tal como las captura el POS. */
  @IsArray()
  @ArrayMaxSize(200)
  cart!: unknown[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  guests?: unknown[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10_000_000)
  total?: number;
}
