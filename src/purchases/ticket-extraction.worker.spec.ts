import { PurchaseStatus } from '@prisma/client';

import { TicketExtractionWorker } from './ticket-extraction.worker';

function buildWorker(options: {
  status: PurchaseStatus | null;
  extract?: jest.Mock;
}) {
  const prisma = {
    purchase: {
      findFirst: jest.fn().mockResolvedValue(
        options.status === null ? null : { status: options.status },
      ),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const extraction = {
    extract:
      options.extract ??
      jest.fn().mockResolvedValue({
        items: [{ id: 'item-1' }],
        status: PurchaseStatus.NEEDS_REVIEW,
      }),
  };

  return {
    worker: new TicketExtractionWorker(
      prisma as never,
      extraction as never,
    ),
    prisma,
    extraction,
  };
}

describe('TicketExtractionWorker', () => {
  it('procesa un ticket en PROCESSING y deja auditoría', async () => {
    const { worker, prisma, extraction } = buildWorker({
      status: PurchaseStatus.PROCESSING,
    });

    await worker.process('org-a', 'purchase-1');

    expect(extraction.extract).toHaveBeenCalledWith('org-a', 'purchase-1');
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'PURCHASE_EXTRACTED',
          entityId: 'purchase-1',
        }),
      }),
    );
  });

  it('reintenta un ticket FAILED', async () => {
    const { worker, extraction } = buildWorker({
      status: PurchaseStatus.FAILED,
    });

    await worker.process('org-a', 'purchase-2');

    expect(extraction.extract).toHaveBeenCalledWith('org-a', 'purchase-2');
  });

  it('no reprocesa un ticket ya revisado', async () => {
    const { worker, extraction, prisma } = buildWorker({
      status: PurchaseStatus.NEEDS_REVIEW,
    });

    await worker.process('org-a', 'purchase-3');

    expect(extraction.extract).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('ignora tickets de otra organización', async () => {
    const { worker, extraction } = buildWorker({ status: null });

    await worker.process('org-a', 'purchase-4');

    expect(extraction.extract).not.toHaveBeenCalled();
  });

  it('propaga el error para que pg-boss reintente', async () => {
    const extract = jest.fn().mockRejectedValue(new Error('visión caída'));
    const { worker } = buildWorker({
      status: PurchaseStatus.PROCESSING,
      extract,
    });

    await expect(worker.process('org-a', 'purchase-5')).rejects.toThrow(
      'visión caída',
    );
  });
});
