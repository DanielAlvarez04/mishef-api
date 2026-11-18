import {
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { imageObjectKeys } from '../uploads/image-assets';
import { deleteR2Object, objectSize } from '../uploads/r2';

/** Límite por sucursal: 250 MB. */
export const STORAGE_LIMIT_PER_BRANCH = 250 * 1024 * 1024;

function formatMb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

/**
 * Cuota de almacenamiento por organización.
 *
 * El contador (`Organization.storageBytes`) se actualiza al guardar y al borrar
 * imágenes optimizadas. El límite es **por sucursal**: un negocio con 3
 * sucursales tiene 750 MB. Si no tiene sucursales, cuenta como una.
 *
 * Se comprueba al firmar la subida (antes de gastar ancho de banda) y otra vez
 * al finalizar; nunca se borra nada existente por pasarse.
 */
@Injectable()
export class StorageService {
  constructor(private readonly prisma: PrismaService) {}

  async usage(organizationId: string) {
    const [organization, branches] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: {
          storageBytes: true,
          subscription: { include: { plan: true } },
        },
      }),
      this.prisma.branch.count({
        where: { organizationId, isActive: true },
      }),
    ]);

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    const units = Math.max(1, branches);
    const perBranch = STORAGE_LIMIT_PER_BRANCH;
    const plan = organization.subscription?.plan;
    const limit =
      plan !== undefined
        ? plan.maxStorageBytes === null
          ? null
          : Number(plan.maxStorageBytes)
        : units * perBranch;
    const used = Number(organization.storageBytes ?? 0n);

    return {
      used,
      limit,
      branches: units,
      remaining: limit === null ? null : Math.max(0, limit - used),
      percent:
        limit === null ? null : limit > 0 ? Math.min(100, (used / limit) * 100) : 0,
      perBranch,
    };
  }

  /** Lanza 413 si la subida no cabe en la cuota restante. */
  async assertWithinLimit(
    organizationId: string | null,
    incomingBytes: number,
  ): Promise<void> {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const { used, limit } = await this.usage(organizationId);

    if (limit === null) return;

    if (used + Math.max(0, incomingBytes) > limit) {
      throw new PayloadTooLargeException(
        `Alcanzaste el límite de almacenamiento (${formatMb(limit)}) de tu plan. ` +
          `Libera espacio eliminando imágenes o amplía tu plan.`,
      );
    }
  }

  /** Suma bytes al contador (al guardar variantes optimizadas). */
  async add(organizationId: string, bytes: number): Promise<void> {
    const amount = Math.max(0, Math.round(bytes));
    if (amount === 0) return;

    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { storageBytes: { increment: BigInt(amount) } },
    });
  }

  /** Suma al contador los bytes reales de una imagen ya guardada. */
  async addImage(organizationId: string, key: string): Promise<void> {
    const bytes = await this.measureImage(key);
    await this.add(organizationId, bytes);
  }

  /**
   * Borra una imagen de R2 y descuenta su espacio.
   *
   * Los bytes se miden **antes** de borrar: si R2 no responde se descuenta 0 y
   * el contador queda por encima de la realidad (nunca por debajo).
   */
  async releaseImage(
    organizationId: string | null,
    key: string,
  ): Promise<void> {
    const objectKeys = imageObjectKeys(key);
    const bytes = await this.measureKeys(objectKeys);

    await Promise.all(objectKeys.map((objectKey) => deleteR2Object(objectKey)));

    if (organizationId) {
      await this.release(organizationId, bytes);
    }
  }

  private async measureImage(key: string): Promise<number> {
    return this.measureKeys(imageObjectKeys(key));
  }

  private async measureKeys(objectKeys: string[]): Promise<number> {
    const sizes = await Promise.all(
      objectKeys.map((objectKey) => objectSize(objectKey)),
    );

    return sizes.reduce<number>((total, size) => total + (size ?? 0), 0);
  }

  /**
   * Resta bytes al borrar imágenes.
   *
   * `bytes` debe ser la suma real de los objetos eliminados (se calcula antes
   * de borrar). La resta es atómica y nunca baja de cero, para que dos borrados
   * simultáneos no se pisen.
   */
  async release(organizationId: string, bytes: number): Promise<void> {
    const amount = Math.max(0, Math.round(bytes));
    if (amount === 0) return;

    await this.prisma.$executeRaw`
      UPDATE "Organization"
      SET "storageBytes" = GREATEST("storageBytes" - ${BigInt(amount)}, 0)
      WHERE "id" = ${organizationId}
    `;
  }
}
