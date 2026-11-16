import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrganizationsService } from './organizations.service';

function build() {
  const prisma: Record<string, any> = {
    organization: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    user: { findUnique: jest.fn() },
    slugAlias: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation((fn: any) => fn(prisma));

  const hostnames = {
    enabled: false,
    create: jest.fn().mockResolvedValue(null),
    remove: jest.fn(),
  };

  const service = new OrganizationsService(
    prisma as unknown as PrismaService,
    hostnames as never,
  );

  return { service, prisma };
}

describe('OrganizationsService — cambio de dirección', () => {
  it('permite fijar la dirección en el onboarding sin gastar el cambio', async () => {
    const { service, prisma } = build();

    prisma.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', slug: 'viejo', slugChanges: 0 })
      .mockResolvedValueOnce(null);
    prisma.slugAlias.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ onboardedAt: null });
    prisma.organization.update.mockResolvedValue({
      slug: 'nuevo',
      slugChanges: 0,
    });

    const result = await service.changeSlug('org-1', 'user-1', 'nuevo');

    expect(result).toEqual({ slug: 'nuevo', slugChanges: 0 });
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { slug: 'nuevo' } }),
    );
    expect(prisma.slugAlias.upsert).toHaveBeenCalled();
  });

  it('después del onboarding permite un cambio y lo cuenta', async () => {
    const { service, prisma } = build();

    prisma.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', slug: 'viejo', slugChanges: 0 })
      .mockResolvedValueOnce(null);
    prisma.slugAlias.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ onboardedAt: new Date() });
    prisma.organization.update.mockResolvedValue({
      slug: 'nuevo',
      slugChanges: 1,
    });

    const result = await service.changeSlug('org-1', 'user-1', 'nuevo');

    expect(result.slugChanges).toBe(1);
    expect(prisma.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { slug: 'nuevo', slugChanges: { increment: 1 } },
      }),
    );
  });

  it('rechaza un segundo cambio', async () => {
    const { service, prisma } = build();

    prisma.organization.findUnique.mockResolvedValueOnce({
      id: 'org-1',
      slug: 'viejo',
      slugChanges: 1,
    });
    prisma.user.findUnique.mockResolvedValue({ onboardedAt: new Date() });

    await expect(
      service.changeSlug('org-1', 'user-1', 'otro'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.organization.update).not.toHaveBeenCalled();
  });

  it('rechaza una dirección que ya usa otro negocio', async () => {
    const { service, prisma } = build();

    prisma.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', slug: 'viejo', slugChanges: 0 })
      .mockResolvedValueOnce({ id: 'org-2' });
    prisma.slugAlias.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ onboardedAt: new Date() });

    await expect(
      service.changeSlug('org-1', 'user-1', 'ocupado'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza una dirección que fue alias de otro negocio', async () => {
    const { service, prisma } = build();

    prisma.organization.findUnique
      .mockResolvedValueOnce({ id: 'org-1', slug: 'viejo', slugChanges: 0 })
      .mockResolvedValueOnce(null);
    prisma.slugAlias.findUnique.mockResolvedValue({ organizationId: 'org-2' });
    prisma.user.findUnique.mockResolvedValue({ onboardedAt: new Date() });

    await expect(
      service.changeSlug('org-1', 'user-1', 'alias-ajeno'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza la misma dirección actual', async () => {
    const { service, prisma } = build();

    prisma.organization.findUnique.mockResolvedValueOnce({
      id: 'org-1',
      slug: 'misma',
      slugChanges: 0,
    });
    prisma.user.findUnique.mockResolvedValue({ onboardedAt: new Date() });

    await expect(
      service.changeSlug('org-1', 'user-1', 'misma'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
