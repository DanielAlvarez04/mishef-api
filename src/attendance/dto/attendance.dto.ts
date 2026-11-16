import { IsOptional, IsString, MaxLength } from 'class-validator';

export class ClockInDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  note?: string;
}
