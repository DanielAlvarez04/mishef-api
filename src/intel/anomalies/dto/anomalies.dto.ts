import { Type } from 'class-transformer';
import {
  IsISO8601,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class AnomaliesQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
