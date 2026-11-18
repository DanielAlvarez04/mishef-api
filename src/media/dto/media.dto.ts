import { MediaKind } from '@prisma/client';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const MEDIA_ENTITY_TYPES = [
  'ITEM',
  'RECIPE',
  'INGREDIENT',
  'MENU',
] as const;

export type MediaEntityType = (typeof MEDIA_ENTITY_TYPES)[number];

export class MediaEntityDto {
  @IsIn(MEDIA_ENTITY_TYPES)
  entityType!: MediaEntityType;

  @IsString()
  @MaxLength(40)
  entityId!: string;
}

export class PresignMediaDto extends MediaEntityDto {
  @IsEnum(MediaKind)
  kind!: MediaKind;

  @IsString()
  @MaxLength(80)
  contentType!: string;

  @IsInt()
  @Min(1)
  size!: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}

export class FinalizeMediaDto extends MediaEntityDto {
  @IsEnum(MediaKind)
  kind!: MediaKind;

  @IsString()
  @MaxLength(80)
  contentType!: string;

  @IsString()
  @MaxLength(300)
  key!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
