import {
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ClockInDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}

/** Corrección manual de un turno (ADMIN). */
export class UpdateShiftDto {
  @IsOptional()
  @IsISO8601()
  startedAt?: string;

  /** `null` deja el turno abierto. */
  @IsOptional()
  @IsISO8601()
  endedAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string | null;
}
