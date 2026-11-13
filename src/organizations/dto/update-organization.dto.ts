import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

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

  /** IVA por defecto del negocio, como fracción (0.16 = 16 %). */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  taxRate?: number;

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
