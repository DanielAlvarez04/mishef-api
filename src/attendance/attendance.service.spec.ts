import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceService } from './attendance.service';

function build() {
  const prisma: Record<string, any> = {
    shift: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      update: jest.fn(),
    },
    payment: { findMany: jest.fn().mockResolvedValue([]) },
    membership: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const service = new AttendanceService(prisma as unknown as PrismaService);

  return { service, prisma };
}

const FROM = '2026-11-01';
const TO = '2026-11-30';

describe('AttendanceService — checador y propinas', () => {
  it('rechaza abrir dos turnos a la vez', async () => {
    const { service, prisma } = build();
    prisma.shift.findFirst.mockResolvedValue({ id: 's1' });

    await expect(
      service.clockIn('org1', 'u1', null),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza marcar salida sin turno abierto', async () => {
    const { service, prisma } = build();
    prisma.shift.findFirst.mockResolvedValue(null);

    await expect(service.clockOut('org1', 'u1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('reparte el pozo por horas y peso del rol', async () => {
    const { service, prisma } = build();

    prisma.payment.findMany.mockResolvedValue([{ tipAmount: 160 }]);

    prisma.shift.findMany.mockResolvedValue([
      {
        userId: 'u1',
        startedAt: new Date('2026-11-10T10:00:00Z'),
        endedAt: new Date('2026-11-10T20:00:00Z'),
      },
      {
        userId: 'u2',
        startedAt: new Date('2026-11-10T10:00:00Z'),
        endedAt: new Date('2026-11-10T20:00:00Z'),
      },
    ]);

    prisma.membership.findMany.mockResolvedValue([
      { userId: 'u1', roles: ['WAITER'], user: { name: 'Ana' } },
      { userId: 'u2', roles: ['KITCHEN'], user: { name: 'Luis' } },
    ]);

    const result = await service.tipsDistribution('org1', null, FROM, TO);

    // u1: 10 h × 1 = 10  ·  u2: 10 h × 0.6 = 6  ·  total 16
    expect(result.pool).toBe(160);
    expect(result.totalWeight).toBe(16);
    expect(result.participants[0]).toMatchObject({
      userId: 'u1',
      hours: 10,
      weight: 10,
      share: 100,
    });
    expect(result.participants[1]).toMatchObject({
      userId: 'u2',
      hours: 10,
      weight: 6,
      share: 60,
    });
  });

  it('acepta pesos personalizados por rol', async () => {
    const { service, prisma } = build();

    prisma.payment.findMany.mockResolvedValue([{ tipAmount: 100 }]);
    prisma.shift.findMany.mockResolvedValue([
      {
        userId: 'u1',
        startedAt: new Date('2026-11-10T10:00:00Z'),
        endedAt: new Date('2026-11-10T20:00:00Z'),
      },
      {
        userId: 'u2',
        startedAt: new Date('2026-11-10T10:00:00Z'),
        endedAt: new Date('2026-11-10T20:00:00Z'),
      },
    ]);
    prisma.membership.findMany.mockResolvedValue([
      { userId: 'u1', roles: ['WAITER'], user: { name: 'Ana' } },
      { userId: 'u2', roles: ['KITCHEN'], user: { name: 'Luis' } },
    ]);

    const result = await service.tipsDistribution(
      'org1',
      null,
      FROM,
      TO,
      'KITCHEN:1,WAITER:0',
    );

    const ana = result.participants.find((row) => row.userId === 'u1');
    const luis = result.participants.find((row) => row.userId === 'u2');

    expect(ana?.weight).toBe(0);
    expect(ana?.share).toBe(0);
    expect(luis?.share).toBe(100);
  });

  it('sin checador reparte en partes iguales entre quienes recibieron propina', async () => {
    const { service, prisma } = build();

    prisma.payment.findMany.mockResolvedValue([
      { tipAmount: 50, tipRecipientId: 'u1', userId: 'u3' },
      { tipAmount: 50, tipRecipientId: null, userId: 'u2' },
    ]);
    prisma.shift.findMany.mockResolvedValue([]);
    prisma.membership.findMany.mockResolvedValue([
      { userId: 'u1', roles: ['WAITER'], user: { name: 'Ana' } },
      { userId: 'u2', roles: ['WAITER'], user: { name: 'Luis' } },
      { userId: 'u3', roles: ['ADMIN'], user: { name: 'Dueño' } },
    ]);

    const result = await service.tipsDistribution('org1', null, FROM, TO);

    const ana = result.participants.find((row) => row.userId === 'u1');
    const luis = result.participants.find((row) => row.userId === 'u2');

    expect(result.pool).toBe(100);
    expect(ana?.share).toBe(50);
    expect(luis?.share).toBe(50);
  });

  it('no reparte sin propinas', async () => {
    const { service, prisma } = build();
    prisma.payment.findMany.mockResolvedValue([]);
    prisma.shift.findMany.mockResolvedValue([]);

    const result = await service.tipsDistribution('org1', null, FROM, TO);

    expect(result.pool).toBe(0);
    expect(result.participants).toEqual([]);
  });
});
