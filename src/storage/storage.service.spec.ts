import { PayloadTooLargeException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { deleteR2Object, objectSize } from '../uploads/r2';
import { STORAGE_LIMIT_PER_BRANCH, StorageService } from './storage.service';

jest.mock('../uploads/r2', () => ({
  objectSize: jest.fn(),
  deleteR2Object: jest.fn(),
}));

const sizeMock = objectSize as jest.Mock;
const deleteMock = deleteR2Object as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

function build() {
  const prisma: Record<string, any> = {
    organization: {
      findUnique: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    branch: { count: jest.fn().mockResolvedValue(1) },
    $executeRaw: jest.fn().mockResolvedValue(1),
  };

  const service = new StorageService(prisma as unknown as PrismaService);

  return { service, prisma };
}

describe('StorageService — cuota por sucursal', () => {
  it('calcula el límite multiplicando las sucursales activas', async () => {
    const { service, prisma } = build();
    prisma.organization.findUnique.mockResolvedValue({
      storageBytes: 100n * 1024n * 1024n,
    });
    prisma.branch.count.mockResolvedValue(3);

    const usage = await service.usage('org-1');

    expect(usage).toMatchObject({
      used: 100 * 1024 * 1024,
      limit: 3 * STORAGE_LIMIT_PER_BRANCH,
      branches: 3,
      remaining: 3 * STORAGE_LIMIT_PER_BRANCH - 100 * 1024 * 1024,
      perBranch: STORAGE_LIMIT_PER_BRANCH,
    });
    expect(usage.percent).toBeCloseTo(13.33, 1);
  });

  it('cuenta como una sucursal cuando el negocio no tiene ninguna', async () => {
    const { service, prisma } = build();
    prisma.organization.findUnique.mockResolvedValue({ storageBytes: 0n });
    prisma.branch.count.mockResolvedValue(0);

    const usage = await service.usage('org-1');

    expect(usage.branches).toBe(1);
    expect(usage.limit).toBe(STORAGE_LIMIT_PER_BRANCH);
  });

  it('rechaza la subida que no cabe en la cuota', async () => {
    const { service, prisma } = build();
    prisma.organization.findUnique.mockResolvedValue({
      storageBytes: BigInt(STORAGE_LIMIT_PER_BRANCH),
    });

    await expect(
      service.assertWithinLimit('org-1', 1),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
  });

  it('permite la subida que deja el contador justo en el límite', async () => {
    const { service, prisma } = build();
    const used = STORAGE_LIMIT_PER_BRANCH - 1024;
    prisma.organization.findUnique.mockResolvedValue({ storageBytes: BigInt(used) });

    await expect(
      service.assertWithinLimit('org-1', 1024),
    ).resolves.toBeUndefined();
  });

  it('suma los bytes guardados con un incremento atómico', async () => {
    const { service, prisma } = build();

    await service.add('org-1', 1234);

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { storageBytes: { increment: 1234n } },
    });
  });

  it('resta con una sola sentencia atómica que no baja de cero', async () => {
    const { service, prisma } = build();

    await service.release('org-1', 500);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    const [strings, ...values] = prisma.$executeRaw.mock.calls[0];
    expect(strings.join('?')).toContain('GREATEST');
    expect(values).toEqual([500n, 'org-1']);
  });

  it('al borrar una imagen mide sus variantes antes y descuenta el total', async () => {
    const { service, prisma } = build();
    sizeMock.mockResolvedValue(100);

    await service.releaseImage('org-1', 'org-1/catalog/e1/hash-1000x1000');

    // Dos anchos (640 y 1280) × AVIF + JPEG = 4 objetos × 100 bytes.
    expect(sizeMock).toHaveBeenCalledTimes(4);
    expect(deleteMock).toHaveBeenCalledTimes(4);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);

    const [, ...values] = prisma.$executeRaw.mock.calls[0];
    expect(values).toEqual([400n, 'org-1']);
  });

  it('al copiar una imagen suma los bytes reales', async () => {
    const { service, prisma } = build();
    sizeMock.mockResolvedValue(250);

    await service.addImage('org-1', 'org-1/catalog/e1/copia-1000x1000');

    expect(prisma.organization.update).toHaveBeenCalledWith({
      where: { id: 'org-1' },
      data: { storageBytes: { increment: 1000n } },
    });
  });
});
