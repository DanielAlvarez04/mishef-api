import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { SUPPORTED_CURRENCIES } from '../../common/currency';

export class UpdateOrganizationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  domain?: string;

  /** Color primario de la marca, `#rrggbb`. */
  @IsOptional()
  @IsString()
  @Matches(/^#[0-9a-fA-F]{6}$/, {
    message: 'El color debe tener el formato #rrggbb',
  })
  brandColor?: string;

  /** URL pública del logo (normalmente en R2). */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  @Matches(/^https:\/\/\S+$/, {
    message: 'El logo debe ser una URL https',
  })
  logoUrl?: string;

  /** Dirección escrita del negocio. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  /** Latitud en grados decimales (-90 a 90). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-90)
  @Max(90)
  latitude?: number;

  /** Longitud en grados decimales (-180 a 180). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 7 })
  @Min(-180)
  @Max(180)
  longitude?: number;

  /** IVA por defecto del negocio, como fracción (0.16 = 16 %). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  taxRate?: number;

  /** Moneda del negocio (código ISO 4217). */
  @IsOptional()
  @IsString()
  @IsIn(SUPPORTED_CURRENCIES)
  currency?: string;

  // Onboarding fields
  @IsOptional()
  @IsString()
  businessType?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceTypes?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  goals?: string[];

  @IsOptional()
  @IsBoolean()
  hasBranches?: boolean;

  /** Activa/desactiva la sección de insumos core sugeridos. */
  @IsOptional()
  @IsBoolean()
  useCoreSuggestions?: boolean;

  /** Activa/desactiva el modo práctica (no registra analítica de operación). */
  @IsOptional()
  @IsBoolean()
  practiceMode?: boolean;
}
