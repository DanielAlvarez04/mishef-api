import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';

function createMocks() {
  const prisma: Record<string, any> = {
    user: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    organization: { findUnique: jest.fn() },
    membership: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    },
    authSession: { updateMany: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => unknown)(prisma),
    ),
  };

  const service = new UsersService(prisma as unknown as PrismaService);

  return { service, prisma };
}

describe('UsersService', () => {
  it('lista solo las membresías de la organización de la sesión', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findMany.mockResolvedValue([]);

    await service.list('org-1');

    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    );
  });

  it('no permite duplicar el nombre de usuario', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findFirst.mockResolvedValue({ id: 'membership-1' });

    await expect(
      service.create('org-1', {
        username: 'mesero',
        password: 'Naranja123!',
        roles: [Role.WAITER],
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.membership.create).not.toHaveBeenCalled();
  });

  it('no permite duplicar el correo', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findFirst.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'ocupado@naranjapimienta.local',
    });

    await expect(
      service.create('org-1', {
        username: 'nuevo',
        email: 'ocupado@naranjapimienta.local',
        password: 'Naranja123!',
        roles: [Role.WAITER],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rechaza nombres de usuario inválidos', async () => {
    const { service } = createMocks();

    await expect(
      service.create('org-1', {
        username: 'a b',
        password: 'Naranja123!',
        roles: [Role.WAITER],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('crea una cuenta interna sin correo y su membresía', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findFirst.mockResolvedValue(null);
    prisma.user.create.mockResolvedValue({
      id: 'user-2',
      username: 'cocina',
      email: null,
      name: 'Cocina',
    });
    prisma.membership.create.mockResolvedValue({
      username: 'cocina',
      roles: [Role.KITCHEN],
    });

    const result = await service.create('org-1', {
      username: 'Cocina',
      password: 'Naranja123!',
      name: 'Cocina',
      roles: [Role.KITCHEN],
    });

    expect(prisma.user.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        username: 'cocina',
        email: null,
        emailVerified: false,
        onboardedAt: expect.any(Date),
      }),
    });
    expect(prisma.membership.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-2',
        organizationId: 'org-1',
        username: 'cocina',
        branchId: null,
        roles: [Role.KITCHEN],
      },
    });
    expect(result).toMatchObject({
      id: 'user-2',
      username: 'cocina',
      roles: [Role.KITCHEN],
    });
  });

  it('indica que un nombre de usuario libre está disponible', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findFirst.mockResolvedValue(null);

    const result = await service.usernameAvailable('org-1', ' Ana.Perez ');

    expect(prisma.membership.findFirst).toHaveBeenCalledWith({
      where: { organizationId: 'org-1', username: 'ana.perez' },
      select: { id: true },
    });
    expect(result).toEqual({
      username: 'ana.perez',
      available: true,
      message: 'Disponible',
    });
  });

  it('marca como no disponible un nombre de usuario ocupado', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findFirst.mockResolvedValue({ id: 'otro' });

    const result = await service.usernameAvailable('org-1', 'ana.perez');

    expect(result).toEqual({
      username: 'ana.perez',
      available: false,
      reason: 'taken',
      message: 'Ese usuario ya está en uso en este negocio.',
    });
  });

  it('marca como inválido un nombre de usuario fuera de formato', async () => {
    const { service, prisma } = createMocks();

    const result = await service.usernameAvailable('org-1', 'a b');

    expect(result).toEqual({
      username: 'a b',
      available: false,
      reason: 'invalid',
      message:
        'Usa entre 3 y 32 caracteres: letras, números, punto, guion o guion bajo.',
    });
    expect(prisma.membership.findFirst).not.toHaveBeenCalled();
  });

  it('rechaza un username con @dominio (modelo viejo)', async () => {
    const { service } = createMocks();

    const result = await service.usernameAvailable(
      'org-1',
      'ana@naranjapimienta.cafe',
    );

    expect(result.available).toBe(false);
    expect(result.reason).toBe('invalid');
  });

  it('propone el nombre local cuando está libre', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findMany.mockResolvedValue([]);

    const result = await service.suggestUsername('org-1', 'Ana Pérez');

    expect(prisma.membership.findMany).toHaveBeenCalledWith({
      where: {
        organizationId: 'org-1',
        username: { in: expect.arrayContaining(['ana']) },
      },
      select: { username: true },
    });
    expect(result).toEqual({ username: 'ana' });
  });

  it('usa inicial.apellido si el nombre ya está ocupado', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findMany.mockResolvedValue([{ username: 'ana' }]);

    const result = await service.suggestUsername('org-1', 'Ana Pérez');

    expect(result.username).toBe('a.perez');
  });

  it('añade un número si el nombre y la inicial.apellido están ocupados', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findMany.mockResolvedValue([
      { username: 'ana' },
      { username: 'a.perez' },
    ]);

    const result = await service.suggestUsername('org-1', 'Ana Pérez');

    expect(result.username).toBe('a.perez2');
  });

  it('sin organización no propone usuario', async () => {
    const { service } = createMocks();

    const result = await service.suggestUsername(null, 'Ana Pérez');

    expect(result).toEqual({ username: '' });
  });

  it('impide que un administrador se desactive a sí mismo', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      roles: [Role.ADMIN],
      user: { email: 'admin@naranjapimienta.local', name: 'Admin' },
    });

    await expect(
      service.update('org-1', 'user-1', { isActive: false }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('impide quitarse el rol ADMIN a sí mismo', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      roles: [Role.ADMIN],
      user: { email: 'admin@naranjapimienta.local', name: 'Admin' },
    });

    await expect(
      service.update('org-1', 'user-1', { roles: [Role.WAITER] }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exige que quede al menos un administrador activo', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      roles: [Role.ADMIN],
      user: { email: 'otro@naranjapimienta.local', name: 'Otro' },
    });
    prisma.membership.count.mockResolvedValue(0);

    await expect(
      service.update('org-1', 'user-2', { roles: [Role.WAITER] }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no permite operar sobre usuarios de otra organización', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue(null);

    await expect(
      service.update('org-1', 'user-ajeno', { name: 'X' }, 'user-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('actualiza el nombre sin tocar el nombre de usuario', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-2',
      username: 'mesero',
      isActive: true,
      branchId: null,
      roles: [Role.WAITER],
      user: { email: null, username: 'mesero', name: 'Mesero' },
    });
    prisma.membership.update.mockResolvedValue({
      roles: [Role.WAITER],
      isActive: true,
    });

    const result = await service.update(
      'org-1',
      'user-2',
      { name: 'Mesero', surname: 'Pérez' },
      'user-1',
    );

    // El ID (`username`) es inmutable: la actualización no lo envía.
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: expect.objectContaining({ name: 'Mesero Pérez' }),
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: expect.not.objectContaining({ username: expect.anything() }),
    });
    expect(result.username).toBe('mesero');
  });

  it('actualiza la contraseña y revoca las sesiones', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-2',
      username: 'mesero',
      isActive: true,
      branchId: null,
      roles: [Role.WAITER],
      user: { email: null, username: 'mesero', name: 'Mesero' },
    });
    prisma.membership.update.mockResolvedValue({
      roles: [Role.WAITER],
      isActive: true,
    });

    await service.update(
      'org-1',
      'user-2',
      { password: 'Nueva123!' },
      'user-1',
    );

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-2' },
      data: expect.objectContaining({
        passwordHash: expect.any(String),
      }),
    });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-2', revokedAt: null },
      }),
    );
  });

  it('al desactivar revoca las sesiones del usuario', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-2',
      roles: [Role.WAITER],
    });
    prisma.membership.update.mockResolvedValue({});

    await service.deactivate('org-1', 'user-2', 'user-1');

    expect(prisma.membership.update).toHaveBeenCalledWith({
      where: { id: 'membership-1' },
      data: { isActive: false },
    });
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-2', revokedAt: null },
      }),
    );
  });

  it('al eliminar borra la cuenta completa si no pertenece a otra organización', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-2',
      roles: [Role.WAITER],
    });
    prisma.membership.count.mockResolvedValue(0);

    await service.deleteMembership('org-1', 'user-2', 'user-1');

    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-2' },
    });
    expect(prisma.membership.delete).not.toHaveBeenCalled();
  });

  it('al eliminar solo borra la membresía si la cuenta sigue en otra organización', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-1',
      userId: 'user-2',
      roles: [Role.WAITER],
    });
    prisma.membership.count.mockResolvedValue(1);

    await service.deleteMembership('org-1', 'user-2', 'user-1');

    expect(prisma.membership.delete).toHaveBeenCalledWith({
      where: { id: 'membership-1' },
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('no permite eliminarse a sí mismo', async () => {
    const { service } = createMocks();

    await expect(
      service.deleteMembership('org-1', 'user-1', 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('elimina en bloque saltándose al propio actor', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findUnique.mockResolvedValue({
      id: 'membership-2',
      userId: 'user-2',
      roles: [Role.WAITER],
    });
    prisma.membership.count.mockResolvedValue(0);

    const result = await service.deleteMemberships(
      'org-1',
      ['user-1', 'user-2', 'user-2'],
      'user-1',
    );

    expect(result).toEqual({ ok: true, deletedCount: 1 });
    expect(prisma.user.delete).toHaveBeenCalledTimes(1);
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-2' },
    });
  });

  it('purgar desactivados borra la cuenta conservando sus registros', async () => {
    const { service, prisma } = createMocks();
    prisma.membership.findMany.mockResolvedValue([
      { id: 'membership-2', userId: 'user-2' },
    ]);
    prisma.membership.count.mockResolvedValue(0);

    const result = await service.purgeDeletedUsers('org-1');

    expect(result).toEqual({ ok: true, deletedCount: 1 });
    expect(prisma.user.delete).toHaveBeenCalledWith({
      where: { id: 'user-2' },
    });
  });
});
