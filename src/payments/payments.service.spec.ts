import { ForbiddenException } from '@nestjs/common';
import { PaymentStatus, Prisma, Role } from '@prisma/client';

import { PaymentsService } from './payments.service';

function build() {
  const prisma = {
    payment: {
      findFirst: jest.fn(),
      create: jest.fn(),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const events = { publish: jest.fn() };
  const splits = {
    assertPaymentFits: jest.fn(),
    recomputeStatus: jest.fn().mockResolvedValue(undefined),
  };
  const analytics = { recordMany: jest.fn().mockResolvedValue(undefined) };
  const providers = { find: jest.fn() };

  const service = new PaymentsService(
    prisma as never,
    events as never,
    splits as never,
    analytics as never,
    providers as never,
  );

  const order = {
    id: 'o1',
    status: 'OPEN',
    total: new Prisma.Decimal(100),
    branchId: null,
  };

  (service as never as Record<string, jest.Mock>).getOpenOrder = jest
    .fn()
    .mockResolvedValue(order);
  (service as never as Record<string, jest.Mock>).requireOpenSession = jest
    .fn()
    .mockResolvedValue({ id: 's1' });
  (service as never as Record<string, jest.Mock>).totals = jest
    .fn()
    .mockResolvedValue({
      confirmed: new Prisma.Decimal(0),
      pending: new Prisma.Decimal(0),
    });

  return { service, prisma };
}

const offlineDto = {
  amount: 100,
  tipAmount: 0,
  reference: 'AUTH-1234',
  deviceId: 'dev-1',
  createdOfflineAt: new Date(Date.now() + 60_000).toISOString(),
  idempotencyKey: 'offline-1',
};

describe('PaymentsService — cobros offline', () => {
  it('registra la tarjeta como PENDING + reviewRequired y acota la fecha', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue(null);
    prisma.payment.create.mockImplementation(({ data }) => ({
      id: 'p1',
      ...data,
    }));

    const created = await service.registerOfflineCard(
      'org1',
      'u1',
      'o1',
      offlineDto,
    );

    const data = prisma.payment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      method: 'CARD',
      status: PaymentStatus.PENDING,
      reviewRequired: true,
      offlineDeviceId: 'dev-1',
      reference: 'AUTH-1234',
      idempotencyKey: 'offline-1',
    });
    expect(data.createdOfflineAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(created.id).toBe('p1');
  });

  it('devuelve el pago existente al repetir la clave de idempotencia', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue({ id: 'p1', orderId: 'o1' });

    const created = await service.registerOfflineCard(
      'org1',
      'u1',
      'o1',
      offlineDto,
    );

    expect(created).toMatchObject({ id: 'p1', duplicated: true });
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it('confirma y intenta cerrar la cuenta al conciliar', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      status: PaymentStatus.PENDING,
      reference: 'AUTH-1234',
      offlineDeviceId: 'dev-1',
    });
    const confirmInternal = jest
      .fn()
      .mockResolvedValue({ id: 'p1', status: PaymentStatus.CONFIRMED });
    const closeOrder = jest.fn().mockResolvedValue({ id: 'o1' });
    (service as never as Record<string, jest.Mock>).confirmInternal =
      confirmInternal;
    (service as never as Record<string, jest.Mock>).closeOrder = closeOrder;

    const result = await service.reconcile(
      'org1',
      { id: 'u1', roles: [Role.ADMIN] },
      'p1',
      { resolution: 'CONFIRM' },
    );

    expect(confirmInternal).toHaveBeenCalledWith('org1', 'p1', {
      userId: 'u1',
      source: 'offline_reconciliation',
    });
    expect(closeOrder).toHaveBeenCalledWith('org1', 'u1', 'o1');
    expect(result).toMatchObject({ closed: true, order: { id: 'o1' } });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'payment.reconciled',
          newValues: expect.objectContaining({ resolution: 'CONFIRM' }),
        }),
      }),
    );
  });

  it('anula el cobro con motivo al rechazarlo', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      status: PaymentStatus.PENDING,
      reference: 'AUTH-1234',
      offlineDeviceId: 'dev-1',
    });
    const voidPayment = jest
      .fn()
      .mockResolvedValue({ id: 'p1', status: PaymentStatus.CANCELLED });
    (service as never as Record<string, jest.Mock>).voidPayment = voidPayment;

    const result = await service.reconcile(
      'org1',
      { id: 'u1', roles: [Role.ADMIN] },
      'p1',
      { resolution: 'REJECT', reason: 'Voucher ajeno' },
    );

    expect(voidPayment).toHaveBeenCalledWith(
      'org1',
      { id: 'u1', roles: [Role.ADMIN] },
      'p1',
      { reason: 'Voucher ajeno' },
      { providerHandled: true },
    );
    expect(result.payment).toMatchObject({ status: PaymentStatus.CANCELLED });
  });

  it('no permite confirmar a un rol sin payments:confirm', async () => {
    const { service, prisma } = build();
    prisma.payment.findFirst.mockResolvedValue({
      id: 'p1',
      orderId: 'o1',
      status: PaymentStatus.PENDING,
      reference: 'AUTH-1234',
      offlineDeviceId: 'dev-1',
    });

    await expect(
      service.reconcile(
        'org1',
        { id: 'u1', roles: [Role.WAITER] },
        'p1',
        { resolution: 'CONFIRM' },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
