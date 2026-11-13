import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator'

/** Evento enviado desde el POS u otro cliente autenticado. */
export class ClientAnalyticsEventDto {
  /** Nombre del evento (`pos.item_added`, `pos.menu_filtered`, ...). */
  @IsString()
  @MaxLength(80)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  itemId?: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  menuId?: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  subjectId?: string

  @IsOptional()
  @IsString()
  @MaxLength(40)
  orderId?: string

  @IsOptional()
  @IsString()
  @MaxLength(120)
  subjectName?: string

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100_000)
  quantity?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(10_000_000)
  amount?: number

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>
}

export class TrackAnalyticsEventsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ClientAnalyticsEventDto)
  events!: ClientAnalyticsEventDto[]
}
