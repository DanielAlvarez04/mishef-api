import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Filtros del listado de usuarios para el equipo de plataforma. */
export class PlatformUsersQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  organizationId?: string;
}
