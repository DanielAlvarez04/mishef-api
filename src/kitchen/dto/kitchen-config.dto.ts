import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  KitchenMode,
  KitchenPositionLevel,
  KitchenStationType,
} from '@prisma/client';

const CODE = /^[A-Z0-9][A-Z0-9_-]{1,39}$/;

export class UpdateKitchenModeDto {
  @IsEnum(KitchenMode)
  mode!: KitchenMode;
}

export class CreateKitchenStationDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(CODE, {
    message: 'El código usa mayúsculas, números, guion o guion bajo',
  })
  code?: string;

  @IsOptional()
  @IsEnum(KitchenStationType)
  type?: KitchenStationType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateKitchenStationDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(CODE, {
    message: 'El código usa mayúsculas, números, guion o guion bajo',
  })
  code?: string;

  @IsOptional()
  @IsEnum(KitchenStationType)
  type?: KitchenStationType;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  color?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class CreateKitchenPositionDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsString()
  @Matches(CODE, {
    message: 'El código usa mayúsculas, números, guion o guion bajo',
  })
  code?: string;

  @IsOptional()
  @IsEnum(KitchenPositionLevel)
  level?: KitchenPositionLevel;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];
}

export class UpdateKitchenPositionDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsString()
  @Matches(CODE, {
    message: 'El código usa mayúsculas, números, guion o guion bajo',
  })
  code?: string;

  @IsOptional()
  @IsEnum(KitchenPositionLevel)
  level?: KitchenPositionLevel;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  permissions?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateKitchenAssignmentDto {
  @IsOptional()
  @IsString()
  kitchenPositionId?: string | null;

  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  stationIds!: string[];
}

export class CreateKitchenRoutingDto {
  @IsString()
  stationId!: string;

  @IsOptional()
  @IsString()
  itemId?: string;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  menuId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  priority?: number;
}

export class UpdateKitchenRoutingDto {
  @IsOptional()
  @IsString()
  stationId?: string;

  @IsOptional()
  @IsString()
  itemId?: string | null;

  @IsOptional()
  @IsString()
  categoryId?: string | null;

  @IsOptional()
  @IsString()
  menuId?: string | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  priority?: number;
}

export class CreateKitchenCourseDto {
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;
}

export class UpdateKitchenCourseDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  sortOrder?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
