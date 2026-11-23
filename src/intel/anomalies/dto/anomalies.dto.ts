import { Type } from 'class-transformer';
import {
  IsIn,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
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

export class ReviewAnomalyDto {
  @IsIn(['ACKNOWLEDGED', 'DISMISSED'])
  status!: 'ACKNOWLEDGED' | 'DISMISSED';

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
