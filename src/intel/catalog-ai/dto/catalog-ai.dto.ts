import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
} from 'class-validator';

export const CATALOG_AI_FIELDS = [
  'description',
  'allergens',
  'category',
  'translations',
  'marketingCopy',
] as const;

export type CatalogAiField = (typeof CATALOG_AI_FIELDS)[number];

export class GenerateCatalogProposalsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsString({ each: true })
  itemIds!: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(CATALOG_AI_FIELDS.length)
  @IsIn(CATALOG_AI_FIELDS, { each: true })
  fields?: CatalogAiField[];
}

export class ApplyCatalogProposalDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(CATALOG_AI_FIELDS.length)
  @IsIn(CATALOG_AI_FIELDS, { each: true })
  fields!: CatalogAiField[];
}
