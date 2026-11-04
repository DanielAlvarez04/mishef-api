import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { parseCsv } from './csv';

const REQUIRED_COLUMNS = ['name', 'price'] as const;

/**
 * Las cabeceras se comparan sin distinguir mayúsculas, pero internamente se
 * trabaja con los nombres canónicos (`taxRate`, `isActive`).
 */
const COLUMN_ALIASES: Record<string, string> = {
  sku: 'sku',
  name: 'name',
  category: 'category',
  description: 'description',
  price: 'price',
  taxrate: 'taxRate',
  isactive: 'isActive',
};
const ALLOWED_COLUMNS = [
  'sku',
  'name',
  'category',
  'description',
  'price',
  'taxRate',
  'isActive',
] as const;
const MAX_ROWS = 2000;
const SKU_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface ImportRowError {
  row: number;
  column?: string;
  message: string;
}

export interface ImportResult {
  dryRun: boolean;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
}

class RowError extends Error {
  constructor(
    message: string,
    readonly column?: string,
  ) {
    super(message);
  }
}

@Injectable()
export class CatalogImportService {
  constructor(private readonly prisma: PrismaService) {}

  async importItems(
    organizationId: string | null,
    csv: string,
    dryRun = false,
  ): Promise<ImportResult> {
    const rows = parseCsv(csv);

    if (rows.length === 0) {
      throw new BadRequestException('El CSV está vacío');
    }

    const rawHeader = rows[0].map((cell) => cell.trim().toLowerCase());
    const duplicated = rawHeader.filter(
      (column, index) => rawHeader.indexOf(column) !== index,
    );

    if (duplicated.length > 0) {
      throw new BadRequestException(
        `Columnas duplicadas en el CSV: ${[...new Set(duplicated)].join(', ')}`,
      );
    }

    const missing = REQUIRED_COLUMNS.filter(
      (column) => !rawHeader.includes(column),
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `Faltan columnas obligatorias: ${missing.join(', ')}`,
      );
    }

    const unknown = rawHeader.filter((column) => !(column in COLUMN_ALIASES));
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Columnas desconocidas: ${unknown.join(', ')}. Permitidas: ${ALLOWED_COLUMNS.join(', ')}`,
      );
    }

    const header = rawHeader.map((column) => COLUMN_ALIASES[column]);

    const dataRows = rows.slice(1);

    if (dataRows.length === 0) {
      throw new BadRequestException('El CSV no contiene filas de datos');
    }

    if (dataRows.length > MAX_ROWS) {
      throw new BadRequestException(
        `El CSV supera el máximo de ${MAX_ROWS} filas`,
      );
    }

    const categories = await this.prisma.category.findMany({
      where: { organizationId },
      select: { id: true, name: true },
    });
    const categoryByName = new Map(
      categories.map((category) => [category.name.toLowerCase(), category]),
    );
    const pendingCategories = new Set<string>();

    const result: ImportResult = {
      dryRun,
      totalRows: dataRows.length,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: [],
    };

    for (const [index, cells] of dataRows.entries()) {
      const rowNumber = index + 2;
      const record = Object.fromEntries(
        header.map((column, columnIndex) => [
          column,
          (cells[columnIndex] ?? '').trim(),
        ]),
      );

      try {
        const category = await this.resolveCategory(
          organizationId,
          record.category ?? '',
          categoryByName,
          pendingCategories,
          dryRun,
        );

        const name = await this.resolveName(record.name);
        const sku = this.resolveSku(record.sku);
        const price = this.resolvePrice(record.price);
        const taxRate = this.resolveTaxRate(record.taxRate);
        const isActive = this.resolveBoolean(record.isActive, 'isActive');
        const description = record.description
          ? record.description.slice(0, 500)
          : null;

        const existing = await this.findExisting(
          organizationId,
          sku,
          name,
        );

        if (existing) {
          if (!dryRun) {
            await this.prisma.item.update({
              where: { id: existing.id },
              data: {
                name,
                description,
                categoryId: category?.id ?? null,
                price,
                taxRate,
                ...(isActive === undefined ? {} : { isActive }),
              },
            });
          }
          result.updated += 1;
        } else {
          if (!dryRun) {
            await this.prisma.$transaction(async (tx) => {
              const created = await tx.item.create({
                data: {
                  organizationId,
                  name,
                  description,
                  sku,
                  categoryId: category?.id ?? null,
                  price,
                  taxRate,
                  isActive: isActive ?? true,
                },
              });

              await tx.catalogEntry.create({
                data: { id: created.id, organizationId },
              });
              await tx.item.update({
                where: { id: created.id },
                data: { catalogEntryId: created.id },
              });
            });
          }
          result.created += 1;
        }
      } catch (error) {
        result.skipped += 1;

        // Los errores de negocio (nombre de categoría duplicado, etc.) se
        // reportan por fila en vez de abortar toda la importación.
        const message =
          error instanceof RowError
            ? error.message
            : error instanceof HttpException
              ? extractHttpMessage(error)
              : 'No se pudo importar la fila';

        result.errors.push({
          row: rowNumber,
          column: error instanceof RowError ? error.column : undefined,
          message,
        });
      }
    }

    return result;
  }

  private async resolveCategory(
    organizationId: string | null,
    rawCategory: string,
    categoryByName: Map<string, { id: string; name: string }>,
    pendingCategories: Set<string>,
    dryRun: boolean,
  ) {
    const name = rawCategory.trim();

    if (!name) {
      return null;
    }

    if (name.length > 80) {
      throw new RowError('La categoría supera 80 caracteres', 'category');
    }

    const key = name.toLowerCase();
    const existing = categoryByName.get(key);

    if (existing) {
      return existing;
    }

    if (dryRun || pendingCategories.has(key)) {
      return null;
    }

    try {
      const created = await this.prisma.category.create({
        data: { organizationId, name },
        select: { id: true, name: true },
      });

      categoryByName.set(key, created);
      pendingCategories.add(key);
      return created;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException(
          `La categoría "${name}" ya existe en otra importación`,
        );
      }
      throw error;
    }
  }

  private async resolveName(rawName: string) {
    const name = rawName?.trim();

    if (!name) {
      throw new RowError('El nombre es obligatorio', 'name');
    }

    if (name.length > 120) {
      throw new RowError('El nombre supera 120 caracteres', 'name');
    }

    return name;
  }

  private resolveSku(rawSku: string | undefined) {
    const sku = rawSku?.trim().toUpperCase();

    if (!sku) {
      return null;
    }

    if (sku.length > 60) {
      throw new RowError('El SKU supera 60 caracteres', 'sku');
    }

    if (!SKU_PATTERN.test(sku)) {
      throw new RowError(
        'El SKU solo admite letras, números, punto, guion y guion bajo',
        'sku',
      );
    }

    return sku;
  }

  private resolvePrice(rawPrice: string | undefined) {
    const value = parseDecimal(rawPrice, 2);

    if (value === null || value < 0) {
      throw new RowError(
        'El precio debe ser un número positivo con máximo 2 decimales',
        'price',
      );
    }

    return new Prisma.Decimal(value);
  }

  private resolveTaxRate(rawTaxRate: string | undefined) {
    if (!rawTaxRate?.trim()) {
      return null;
    }

    const value = parseDecimal(rawTaxRate, 4);

    if (value === null || value < 0 || value > 1) {
      throw new RowError(
        'taxRate debe ser una fracción entre 0 y 1 (0.16 = 16 %)',
        'taxRate',
      );
    }

    return new Prisma.Decimal(value);
  }

  private resolveBoolean(
    rawValue: string | undefined,
    column: string,
  ): boolean | undefined {
    const value = rawValue?.trim().toLowerCase();

    if (!value) {
      return undefined;
    }

    if (['true', '1', 'si', 'sí', 'yes'].includes(value)) {
      return true;
    }

    if (['false', '0', 'no'].includes(value)) {
      return false;
    }

    throw new RowError(
      'Valor booleano inválido (usa true/false)',
      column,
    );
  }

  private async findExisting(
    organizationId: string | null,
    sku: string | null,
    name: string,
  ) {
    if (sku) {
      return this.prisma.item.findFirst({
        where: {
          organizationId,
          sku: { equals: sku, mode: 'insensitive' },
        },
        select: { id: true },
      });
    }

    return this.prisma.item.findFirst({
      where: {
        organizationId,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
  }
}

function extractHttpMessage(error: HttpException): string {
  const response = error.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  if (response && typeof response === 'object' && 'message' in response) {
    const message = (response as { message: string | string[] }).message;
    return Array.isArray(message) ? message.join(', ') : message;
  }

  return error.message;
}

function parseDecimal(
  rawValue: string | undefined,
  maxDecimals: number,
): number | null {
  const normalized = (rawValue ?? '').replace(/\s/g, '').replace(',', '.');

  if (!normalized) {
    return null;
  }

  const pattern = new RegExp(`^\\d+(\\.\\d{1,${maxDecimals}})?$`);
  if (!pattern.test(normalized)) {
    return null;
  }

  return Number(normalized);
}
