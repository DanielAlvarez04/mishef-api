import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateDiningTableDto {
  /** Número o nombre corto de la mesa: «4», «Terraza 2». */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  number!: string;

  /** Zona del salón: «Salón», «Terraza», «Barra». */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  zone?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  seats?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateDiningTableDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  number?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  zone?: string | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  seats?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
