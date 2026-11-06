import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/** Artículo incluido dentro de un menú. */
export class MenuItemInputDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  itemId!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /** Sección del menú; debe existir en `groups` (vacío = «Sin grupo»). */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  group?: string | null;
}

/** Secciones del menú, en el orden en que se muestran en el POS. */
const MENU_GROUPS = {
  max: 30,
  nameLength: 40,
} as const;

/** Menú: colección curada de artículos, opcionalmente programada. */
export class CreateMenuDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  /** 0 = domingo … 6 = sábado. Vacío = todos los días. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  /** Hora local "HH:MM"; ambas vacías = todo el día. */
  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'La hora debe tener el formato HH:MM',
  })
  startTime?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'La hora debe tener el formato HH:MM',
  })
  endTime?: string | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  /** Secciones del menú, en orden; los artículos se asignan por nombre. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MENU_GROUPS.max)
  @IsString({ each: true })
  @MaxLength(MENU_GROUPS.nameLength, { each: true })
  groups?: string[];

  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MenuItemInputDto)
  items!: MenuItemInputDto[];
}

export class UpdateMenuDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'La hora debe tener el formato HH:MM',
  })
  startTime?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    message: 'La hora debe tener el formato HH:MM',
  })
  endTime?: string | null;

  @IsOptional()
  @IsDateString()
  startsAt?: string | null;

  @IsOptional()
  @IsDateString()
  endsAt?: string | null;

  /** Si se envía, reemplaza la selección completa de artículos. */
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MenuItemInputDto)
  items?: MenuItemInputDto[];

  /** Si se envía, reemplaza las secciones del menú. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MENU_GROUPS.max)
  @IsString({ each: true })
  @MaxLength(MENU_GROUPS.nameLength, { each: true })
  groups?: string[];
}

export class ReplaceMenuItemsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => MenuItemInputDto)
  items!: MenuItemInputDto[];

  /** Secciones vigentes; solo se usan para validar `items[].group`. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MENU_GROUPS.max)
  @IsString({ each: true })
  @MaxLength(MENU_GROUPS.nameLength, { each: true })
  groups?: string[];
}
