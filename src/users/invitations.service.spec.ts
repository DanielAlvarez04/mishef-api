import { BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { InvitationsService } from './invitations.service';

function build() {
  const tx = {
    user: { create: jest.fn().mockResolvedValue({ id: 'u2' }) },
    membership: { create: jest.fn().mockResolvedValue({ id: 'm2' }) },
    invitation: { update: jest.fn().mockResolvedValue({}) },
  };

  const prisma: Record<string, any> = {
    invitation: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    membership: {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
    },
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    organization: { findUnique: jest.fn() },
    $transaction: jest.fn(async (input: any) =>
      typeof input === 'function' ? input(tx) : Promise.all(input),
    ),
  };

  const mail = { send: jest.fn().mockResolvedValue(undefined) };

  const config = {
    get: (key: string) =>
      key === 'WEB_ORIGIN' ? 'https://app.mishef.co' : undefined,
  };

  const service = new InvitationsService(
    prisma as unknown as PrismaService,
    mail as unknown as MailService,
    config as unknown as ConfigService,
  );

  return { service, prisma, mail, tx };
}

const pendingInvitation = {
  id: 'inv1',
  organizationId: 'org1',
  email: 'ana@cafe.com',
  name: 'Ana',
  username: 'ana',
  roles: ['WAITER'],
  branchId: null,
  acceptedAt: null,
  expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  organization: { name: 'Café Central', slug: 'cafe-central' },
};

describe('InvitationsService', () => {
  it('envía la invitación con un enlace y no guarda el token en claro', async () => {
    const { service, prisma, mail } = build();
    prisma.membership.findFirst.mockResolvedValue(null);
    prisma.organization.findUnique.mockResolvedValue({
      name: 'Café Central',
      slug: 'cafe-central',
    });
    prisma.invitation.create.mockImplementation(({ data }: any) =>
      Promise.resolve({
        id: 'inv1',
        email: data.email,
        roles: data.roles,
        expiresAt: data.expiresAt,
      }),
    );

    const result = await service.create('org1', 'admin1', {
      email: 'Ana@Cafe.com',
    } as any);

    expect(mail.send).toHaveBeenCalledTimes(1);
    const message = mail.send.mock.calls[0][0];
    expect(message.to).toBe('ana@cafe.com');
    expect(message.text).toContain('https://app.mishef.co/join/');

    const data = prisma.invitation.create.mock.calls[0][0].data;
    // El token viaja en el enlace, pero en la base solo queda su hash.
    expect(data.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.link).toContain('https://app.mishef.co/join/');
  });

  it('rechaza invitar a alguien que ya pertenece al equipo', async () => {
    const { service, prisma } = build();
    prisma.membership.findFirst.mockResolvedValue({ id: 'm1' });

    await expect(
      service.create('org1', 'admin1', { email: 'ana@cafe.com' } as any),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('crea la cuenta verificada y la membresía al aceptar', async () => {
    const { service, prisma, tx } = build();
    prisma.invitation.findUnique.mockResolvedValue(pendingInvitation);
    prisma.user.findUnique.mockResolvedValue(null);

    const result = await service.accept('token-valido', {
      name: 'Ana',
      password: 'secreto123',
    });

    expect(result).toEqual({
      ok: true,
      organizationSlug: 'cafe-central',
      username: 'ana',
      alreadyHadAccount: false,
    });
    expect(tx.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'ana@cafe.com',
          emailVerified: true,
        }),
      }),
    );
    expect(tx.membership.create).toHaveBeenCalledWith({
      data: {
        userId: 'u2',
        organizationId: 'org1',
        username: 'ana',
        roles: ['WAITER'],
        branchId: null,
      },
    });
    expect(tx.invitation.update).toHaveBeenCalled();
  });

  it('rechaza una invitación caducada', async () => {
    const { service, prisma } = build();
    prisma.invitation.findUnique.mockResolvedValue({
      ...pendingInvitation,
      expiresAt: new Date(Date.now() - 1000),
    });

    await expect(service.preview('token')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('oculta parte del correo en la vista previa', async () => {
    const { service, prisma } = build();
    prisma.invitation.findUnique.mockResolvedValue(pendingInvitation);
    prisma.user.findUnique.mockResolvedValue(null);

    const preview = await service.preview('token');

    expect(preview.email).toBe('an*@cafe.com');
    expect(preview.organizationName).toBe('Café Central');
    expect(preview.alreadyHasAccount).toBe(false);
  });
});
