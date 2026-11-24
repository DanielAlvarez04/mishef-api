import { ReceiptTemplateSettingsService } from './receipt-template-settings.service';
import { defaultReceiptTemplate } from './point-receipt';

function createMocks() {
  const prisma = {
    platformSetting: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      deleteMany: jest.fn(),
    },
    branch: {
      updateMany: jest.fn(),
    },
  };

  const service = new ReceiptTemplateSettingsService(prisma as never);

  return { service, prisma };
}

describe('ReceiptTemplateSettingsService', () => {
  it('usa la plantilla del código si no hay global guardada', async () => {
    const { service, prisma } = createMocks();
    prisma.platformSetting.findUnique.mockResolvedValue(null);

    await expect(service.getGlobal()).resolves.toEqual(
      defaultReceiptTemplate(),
    );
  });

  it('prioriza el override de sucursal y cae a la global', async () => {
    const { service, prisma } = createMocks();
    const global = { ...defaultReceiptTemplate(), printLogo: true };
    prisma.platformSetting.findUnique.mockResolvedValue({ value: global });

    const branch = { ...defaultReceiptTemplate(), printLogo: false };

    await expect(service.getForBranch(branch)).resolves.toEqual(branch);
    await expect(service.getForBranch(null)).resolves.toEqual(global);
    await expect(service.getForBranch({ blocks: [] })).resolves.toEqual(
      global,
    );
  });

  it('restablece la global borrando la configuración', async () => {
    const { service, prisma } = createMocks();
    prisma.platformSetting.deleteMany.mockResolvedValue({ count: 1 });

    await expect(service.saveGlobal(null)).resolves.toEqual(
      defaultReceiptTemplate(),
    );
    expect(prisma.platformSetting.deleteMany).toHaveBeenCalledWith({
      where: { key: 'receipt.template.global' },
    });
  });
});
