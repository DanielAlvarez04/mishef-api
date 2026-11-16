import {
  BadRequestException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { Prisma, UnitCode, WasteReason } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  deleteR2Object,
  getR2Object,
  maxUploadBytes,
} from '../uploads/r2';
import { storeOptimizedImage } from '../uploads/image-storage';
import { WasteService } from './waste.service';

jest.mock('../uploads/r2', () => {
  const actual = jest.requireActual('../uploads/r2');

  return {
    ...actual,
    getR2Object: jest.fn(),
    deleteR2Object: jest.fn(),
    maxUploadBytes: jest.fn(() => 5 * 1024 * 1024),
  };
});

jest.mock('../uploads/image-storage', () => ({
  storeOptimizedImage: jest.fn(),
}));

const getMock = getR2Object as jest.Mock;
const deleteMock = deleteR2Object as jest.Mock;
const optimizeMock = storeOptimizedImage as jest.Mock;
const maxMock = maxUploadBytes as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  maxMock.mockReturnValue(5 * 1024 * 1024);
});

function build() {
  const prisma: Record<string, any> = {
    ingredient: { findFirst: jest.fn() },
    waste: {
      create: jest.fn().mockImplementation(({ data }) =>
        Promise.resolve({ id: 'w1', ...data }),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  const storage = {
    add: jest.fn(),
    assertWithinLimit: jest.fn(),
    releaseImage: jest.fn(),
  };

  const service = new WasteService(
    prisma as unknown as PrismaService,
    storage as never,
  );

  return { service, prisma, storage };
}

const ingredient = {
  id: 'i1',
  name: 'Leche',
  displayUnit: UnitCode.ML,
  unitCost: new Prisma.Decimal('0.02'),
};

describe('WasteService — merma', () => {
  it('calcula el costo con el costo actual del insumo', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);

    const result = await service.create('org1', 'u1', null, {
      ingredientId: 'i1',
      quantity: '500',
      reason: WasteReason.SPILL,
    });

    // 500 ml × 0.02 = 10
    expect(result.cost.toString()).toBe('10');
    expect(result.quantity.toString()).toBe('500');

    const data = prisma.waste.create.mock.calls[0][0].data;
    expect(data.ingredientName).toBe('Leche');
    expect(data.reason).toBe(WasteReason.SPILL);
  });

  it('convierte desde una unidad mayor', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);

    await service.create('org1', 'u1', null, {
      ingredientId: 'i1',
      quantity: '1.5',
      unit: UnitCode.L,
      reason: WasteReason.EXPIRED,
    });

    // 1.5 L = 1500 ml × 0.02 = 30
    const data = prisma.waste.create.mock.calls[0][0].data;
    expect(data.quantity.toString()).toBe('1500');
    expect(data.cost.toString()).toBe('30');
  });

  it('rechaza cantidades no positivas', async () => {
    const { service, prisma } = build();

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '0',
        reason: WasteReason.OTHER,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.waste.create).not.toHaveBeenCalled();
  });

  it('rechaza una unidad de otra dimensión', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '1',
        unit: UnitCode.UNIT,
        reason: WasteReason.DAMAGED,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rechaza un insumo de otra organización', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(null);

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'ajeno',
        quantity: '1',
        reason: WasteReason.OTHER,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('suma el costo y agrupa por motivo', async () => {
    const { service, prisma } = build();

    prisma.waste.findMany.mockResolvedValue([
      {
        id: 'w1',
        ingredientName: 'Leche',
        quantity: new Prisma.Decimal(500),
        displayUnit: UnitCode.ML,
        reason: WasteReason.SPILL,
        note: null,
        cost: new Prisma.Decimal('10.00'),
        photoUrl: null,
        createdAt: new Date('2026-11-10T10:00:00Z'),
        user: null,
      },
      {
        id: 'w2',
        ingredientName: 'Pan',
        quantity: new Prisma.Decimal(3),
        displayUnit: UnitCode.UNIT,
        reason: WasteReason.EXPIRED,
        note: null,
        cost: new Prisma.Decimal('15.50'),
        photoUrl: null,
        createdAt: new Date('2026-11-11T10:00:00Z'),
        user: null,
      },
    ]);

    const result = await service.list('org1', null);

    expect(result.total).toBe(25.5);
    expect(result.byReason).toEqual(
      expect.arrayContaining([
        { reason: WasteReason.SPILL, count: 1, cost: 10 },
        { reason: WasteReason.EXPIRED, count: 1, cost: 15.5 },
      ]),
    );
  });

  it('no devuelve nada sin organización', async () => {
    const { service, prisma } = build();

    const result = await service.list(null, null);

    expect(result).toEqual({ items: [], total: 0, byReason: [] });
    expect(prisma.waste.findMany).not.toHaveBeenCalled();
  });
});

describe('WasteService — foto optimizada y cuota', () => {
  const tempKey = 'org1/tmp/foto.jpg';
  const buffer = Buffer.from('foto-original');

  const stored = {
    key: 'org1/waste/hash-1000x1000',
    bytes: 2048,
    assets: {
      width: 1000,
      height: 1000,
      variants: [
        {
          width: 640,
          height: 640,
          avif: 'https://img.test/org1/waste/hash-640.avif',
          jpg: 'https://img.test/org1/waste/hash-640.jpg',
        },
        {
          width: 1000,
          height: 1000,
          avif: 'https://img.test/org1/waste/hash-1000.avif',
          jpg: 'https://img.test/org1/waste/hash-1000.jpg',
        },
      ],
    },
  };

  it('rechaza la foto de otro negocio', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '10',
        reason: WasteReason.SPILL,
        photoKey: 'org2/tmp/foto.jpg',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(getMock).not.toHaveBeenCalled();
    expect(prisma.waste.create).not.toHaveBeenCalled();
  });

  it('rechaza la foto temporal que ya no está en R2', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);
    getMock.mockResolvedValue(null);

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '10',
        reason: WasteReason.SPILL,
        photoKey: tempKey,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.waste.create).not.toHaveBeenCalled();
  });

  it('rechaza la foto que supera el máximo y borra el temporal', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);
    maxMock.mockReturnValue(1024);
    getMock.mockResolvedValue(Buffer.alloc(2048));

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '10',
        reason: WasteReason.SPILL,
        photoKey: tempKey,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(deleteMock).toHaveBeenCalledWith(tempKey);
    expect(prisma.waste.create).not.toHaveBeenCalled();
  });

  it('rechaza si las variantes no caben en la cuota y las borra', async () => {
    const { service, prisma, storage } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);
    getMock.mockResolvedValue(buffer);
    optimizeMock.mockResolvedValue(stored);
    storage.assertWithinLimit.mockRejectedValue(
      new PayloadTooLargeException('sin espacio'),
    );

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '10',
        reason: WasteReason.SPILL,
        photoKey: tempKey,
      }),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);

    expect(storage.releaseImage).toHaveBeenCalledWith(null, stored.key);
    expect(prisma.waste.create).not.toHaveBeenCalled();
  });

  it('optimiza la foto, guarda la clave y suma los bytes reales', async () => {
    const { service, prisma, storage } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);
    getMock.mockResolvedValue(buffer);
    optimizeMock.mockResolvedValue(stored);

    const result = await service.create('org1', 'u1', null, {
      ingredientId: 'i1',
      quantity: '10',
      reason: WasteReason.SPILL,
      photoKey: tempKey,
    });

    expect(optimizeMock).toHaveBeenCalledWith('org1/waste', buffer);
    expect(deleteMock).toHaveBeenCalledWith(tempKey);
    expect(result.photoKey).toBe(stored.key);
    expect(result.photoUrl).toBe(
      'https://img.test/org1/waste/hash-1000.jpg',
    );
    expect(storage.assertWithinLimit).toHaveBeenCalledWith('org1', 2048);
    expect(storage.add).toHaveBeenCalledWith('org1', 2048);

    const data = prisma.waste.create.mock.calls[0][0].data;
    expect(data.photoKey).toBe(stored.key);
    expect(data.photoUrl).toBe('https://img.test/org1/waste/hash-1000.jpg');
  });

  it('borra el temporal aunque la optimización falle', async () => {
    const { service, prisma } = build();
    prisma.ingredient.findFirst.mockResolvedValue(ingredient);
    getMock.mockResolvedValue(buffer);
    optimizeMock.mockRejectedValue(new Error('sharp falló'));

    await expect(
      service.create('org1', 'u1', null, {
        ingredientId: 'i1',
        quantity: '10',
        reason: WasteReason.SPILL,
        photoKey: tempKey,
      }),
    ).rejects.toThrow('sharp falló');

    expect(deleteMock).toHaveBeenCalledWith(tempKey);
    expect(prisma.waste.create).not.toHaveBeenCalled();
  });
});
