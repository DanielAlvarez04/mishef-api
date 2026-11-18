import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class PublicPlansQueryDto {
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeHidden?: boolean;
}

export class CreatePlanDto {
  @IsString()
  @Matches(/^[a-z0-9-]+$/, {
    message: 'El código solo puede tener minúsculas, números y guiones',
  })
  @MaxLength(40)
  code!: string;

  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsNumber()
  @Min(0)
  priceMonthly!: number;

  @IsNumber()
  @Min(0)
  priceYearly!: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsOptional()
  @IsBoolean()
  perBranch?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  trialDays?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxBranches?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxUsersPerBranch?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  maxImagesPerItem?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  maxVideosPerItem?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxStorageBytes?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  maxInventoryItems?: number | null;

  @IsOptional()
  @IsBoolean()
  customDomain?: boolean;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;

  @IsOptional()
  features?: unknown;
}

export class UpdatePlanDto extends PartialType(CreatePlanDto) {}

export class SubscribeDto {
  @IsString()
  @MaxLength(40)
  planCode!: string;

  @IsEnum(BillingInterval)
  interval!: BillingInterval;

  @IsEmail()
  @MaxLength(200)
  payerEmail!: string;
}

export class ChangePlanDto {
  @IsString()
  @MaxLength(40)
  planCode!: string;

  @IsEnum(BillingInterval)
  interval!: BillingInterval;
}

export class ManualSubscriptionDto {
  @IsOptional()
  @IsString()
  @MaxLength(40)
  planCode?: string;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional()
  @IsEnum(BillingInterval)
  interval?: BillingInterval;

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsString()
  currentPeriodEnd?: string | null;

  @IsOptional()
  @IsString()
  trialEndsAt?: string | null;

  @IsOptional()
  @IsString()
  graceEndsAt?: string | null;

  @IsOptional()
  @IsEmail()
  payerEmail?: string | null;
}

export class PlatformOrganizationsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  planCode?: string;
}
