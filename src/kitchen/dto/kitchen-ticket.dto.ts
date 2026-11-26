import { KitchenTicketStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';

export class TransitionKitchenTicketDto {
  @IsEnum(KitchenTicketStatus)
  status!: KitchenTicketStatus;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
