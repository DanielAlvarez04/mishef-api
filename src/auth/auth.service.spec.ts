import { UnauthorizedException, BadRequestException, ConflictException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { hash } from 'argon2';
import { AuthService } from './auth.service';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

const ACCESS_SECRET = 'access-secret';
const REFRESH_SECRET = 'refresh-secret';

function createMocks() {
  const prisma: Record<string, any> = {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
    },
    membership: { create: jest.fn() },
    organization: { create: jest.fn() },
    authSession: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    twoFactorCode: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    emailVerificationToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
    },
    passwordResetToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      deleteMany: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => unknown)(prisma),
    ),
  };

  const jwt = {
    signAsync: jest.fn().mockResolvedValue('signed.jwt.token'),
    verifyAsync: jest.fn(),
  };

  const config = {
    get: (key: string) => {
      if (key === 'JWT_ACCESS_SECRET') return ACCESS_SECRET;
      if (key === 'JWT_REFRESH_SECRET') return REFRESH_SECRET;
      return undefined;
    },
  } as unknown as ConfigService;

  const mail = { send: jest.fn().mockResolvedValue(undefined) };

  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt as unknown as JwtService,
    config,
    mail as unknown as MailService,
  );

  return { service, prisma, jwt, mail };
}

async function userFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'user-1',
    email: 'admin@naranjapimienta.local',
    name: 'Admin',
    isActive: true,
    emailVerified: false,
    twoFactorEnabled: false,
    passwordHash: await hash('Naranja123!'),
    memberships: [
      {
        roles: ['ADMIN'],
        organizationId: 'org-1',
        organization: { id: 'org-1', name: 'Naranja Pimienta' },
      },
    ],
    ...overrides,
  };
}

describe('AuthService', () => {
  it('inicia sesión y crea una sesión persistida', async () => {
    const { service, prisma } = createMocks();
    prisma.user.findUnique.mockResolvedValue(await userFixture());

    const result = await service.login({
      identifier: '  ADMIN@naranjapimienta.local ',
      password: 'Naranja123!',
    });

    expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      user: { id: 'user-1', roles: ['ADMIN'], organizationId: 'org-1' },
    });
    expect(result).not.toHaveProperty('twoFactorRequired');
  });

  it('inicia sesión con el nombre de usuario de una cuenta interna', async () => {
    const { service, prisma } = createMocks();
    prisma.user.findUnique.mockResolvedValue(
      await userFixture({ username: 'mesero', email: null }),
    );

    const result = await service.login({
      identifier: ' MESERO ',
      password: 'Naranja123!',
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { username: 'mesero' } }),
    );
    expect(result).toMatchObject({ user: { id: 'user-1' } });
  });

  it('no permite entrar con un usuario que parece correo', async () => {
    const { service, prisma } = createMocks();
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.login({
        identifier: 'ana@naranjapimienta.cafe',
        password: 'Naranja123!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    // Una sola consulta, por correo. El nombre de usuario con `@` ya no es una
    // vía de acceso: se eliminó para que no se confundan cuentas.
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'ana@naranjapimienta.cafe' },
      }),
    );
  });

  it('rechaza una cuenta sin contraseña (solo Google)', async () => {
    const { service, prisma } = createMocks();
    prisma.user.findUnique.mockResolvedValue(
      await userFixture({ passwordHash: null }),
    );

    await expect(
      service.login({
        identifier: 'admin@naranjapimienta.local',
        password: 'Naranja123!',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rechaza credenciales inválidas sin crear sesión', async () => {
    const { service, prisma } = createMocks();
    prisma.user.findUnique.mockResolvedValue(await userFixture());

    await expect(
      service.login({
        identifier: 'admin@naranjapimienta.local',
        password: 'incorrecta',
      }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.authSession.create).not.toHaveBeenCalled();
  });

  it('con 2FA activo no entrega sesión y envía un código', async () => {
    const { service, prisma, mail } = createMocks();
    prisma.user.findUnique.mockResolvedValue(
      await userFixture({ twoFactorEnabled: true }),
    );
    prisma.twoFactorCode.create.mockResolvedValue({});

    const result = (await service.login({
      identifier: 'admin@naranjapimienta.local',
      password: 'Naranja123!',
    })) as { twoFactorRequired: boolean; challengeId: string };

    expect(result.twoFactorRequired).toBe(true);
    expect(result.challengeId).toEqual(expect.any(String));
    expect(prisma.authSession.create).not.toHaveBeenCalled();
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('verifica el código de 2FA y emite la sesión', async () => {
    const { service, prisma } = createMocks();
    const codeHash = await hash('123456');

    prisma.twoFactorCode.findUnique.mockResolvedValue({
      id: 'challenge-1',
      userId: 'user-1',
      purpose: 'LOGIN',
      codeHash,
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    prisma.user.findUnique.mockResolvedValue(await userFixture());

    const result = await service.verifyTwoFactor('challenge-1', '123456');

    expect(result).toHaveProperty('accessToken');
    expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    expect(prisma.twoFactorCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { consumedAt: expect.any(Date) } }),
    );
  });

  it('cuenta los intentos fallidos de 2FA', async () => {
    const { service, prisma } = createMocks();

    prisma.twoFactorCode.findUnique.mockResolvedValue({
      id: 'challenge-1',
      userId: 'user-1',
      purpose: 'LOGIN',
      codeHash: await hash('123456'),
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.verifyTwoFactor('challenge-1', '000000'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(prisma.twoFactorCode.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ attempts: 1 }) }),
    );
    expect(prisma.authSession.create).not.toHaveBeenCalled();
  });

  it('rechaza un código 2FA caducado', async () => {
    const { service, prisma } = createMocks();

    prisma.twoFactorCode.findUnique.mockResolvedValue({
      id: 'challenge-1',
      userId: 'user-1',
      purpose: 'LOGIN',
      codeHash: await hash('123456'),
      attempts: 0,
      consumedAt: null,
      expiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      service.verifyTwoFactor('challenge-1', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rota el refresh token y enlaza la sesión anterior', async () => {
    const { service, prisma, jwt } = createMocks();

    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      sid: 'session-1',
      type: 'refresh',
    });
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      refreshTokenHash: await hash('refresh-token'),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    });
    prisma.authSession.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findUnique.mockResolvedValue(await userFixture());

    const result = await service.refresh('refresh-token');

    expect(result).toHaveProperty('refreshToken');
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'session-1', revokedAt: null },
        data: expect.objectContaining({ revokedReason: 'ROTATED' }),
      }),
    );
    expect(prisma.authSession.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { replacedBySessionId: expect.any(String) },
      }),
    );
  });

  it('detecta reutilización de un refresh revocado y revoca todo', async () => {
    const { service, prisma, jwt } = createMocks();

    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      sid: 'session-1',
      type: 'refresh',
    });
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      refreshTokenHash: await hash('refresh-token'),
      revokedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    });

    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'REUSE_DETECTED' }),
      }),
    );
  });

  it('una pestaña con un refresh ya rotado no revoca las demás sesiones', async () => {
    const { service, prisma, jwt } = createMocks();

    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      sid: 'session-1',
      type: 'refresh',
    });
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      refreshTokenHash: await hash('refresh-token'),
      revokedAt: new Date(Date.now() - 10 * 60_000),
      revokedReason: 'ROTATED',
      replacedBySessionId: 'session-2',
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    });

    try {
      await service.refresh('refresh-token');
      throw new Error('Debió rechazar el refresh');
    } catch (error) {
      expect((error as UnauthorizedException).getResponse()).toMatchObject({
        code: 'SESSION_ROTATED',
      });
    }

    expect(prisma.authSession.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'REUSE_DETECTED' }),
      }),
    );
  });

  it('no permite dos rotaciones concurrentes del mismo refresh', async () => {
    const { service, prisma, jwt } = createMocks();

    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      sid: 'session-1',
      type: 'refresh',
    });
    prisma.authSession.findUnique.mockResolvedValue({
      id: 'session-1',
      userId: 'user-1',
      refreshTokenHash: await hash('refresh-token'),
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      absoluteExpiresAt: new Date(Date.now() + 120_000),
    });
    prisma.authSession.updateMany.mockResolvedValue({ count: 0 });
    prisma.user.findUnique.mockResolvedValue(await userFixture());

    await expect(service.refresh('refresh-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );

    expect(prisma.authSession.create).not.toHaveBeenCalled();
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'REUSE_DETECTED' }),
      }),
    );
  });

  it('logout revoca solo la sesión presentada', async () => {
    const { service, prisma, jwt } = createMocks();

    jwt.verifyAsync.mockResolvedValue({
      sub: 'user-1',
      sid: 'session-1',
      type: 'refresh',
    });

    await service.logout('refresh-token');

    expect(prisma.authSession.updateMany).toHaveBeenCalledWith({
      where: { id: 'session-1', revokedAt: null },
      data: { revokedAt: expect.any(Date), revokedReason: 'LOGOUT' },
    });
    expect(prisma.authSession.updateMany).toHaveBeenCalledTimes(1);
  });

  it('restablecer contraseña revoca las sesiones activas', async () => {
    const { service, prisma, mail } = createMocks();
    const secret = 'secret-token';
    prisma.user.findUnique.mockResolvedValue(await userFixture());

    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'reset-1',
      userId: 'user-1',
      tokenHash: await hash(secret),
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await service.resetPassword(`reset-1.${secret}`, 'NuevaClave123');

    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' } }),
    );
    expect(prisma.authSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: 'PASSWORD_CHANGED' }),
      }),
    );
    expect(mail.send).toHaveBeenCalledTimes(1);
  });

  it('rechaza un token de recuperación inválido', async () => {
    const { service, prisma } = createMocks();

    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'reset-1',
      userId: 'user-1',
      tokenHash: await hash('otro-secreto'),
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(
      service.resetPassword('reset-1.secreto-invalido', 'NuevaClave123'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('no cambia la contraseña si la actual no coincide', async () => {
    const { service, prisma } = createMocks();
    prisma.user.findUnique.mockResolvedValue(await userFixture());

    await expect(
      service.changePassword('user-1', 'incorrecta', 'NuevaClave123'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('no desactiva 2FA sin la contraseña correcta', async () => {
    const { service, prisma } = createMocks();
    prisma.user.findUnique.mockResolvedValue(
      await userFixture({ twoFactorEnabled: true }),
    );

    await expect(
      service.disableTwoFactor('user-1', 'incorrecta'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  describe('registro público', () => {
    it('crea la organización y deja al usuario como ADMIN con sesión', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(await userFixture({ email: 'nueva@cafe.com' }));
      prisma.organization.create.mockResolvedValue({ id: 'org-1' });
      prisma.user.create.mockResolvedValue({
        id: 'user-1',
        email: 'nueva@cafe.com',
      });
      prisma.membership.create.mockResolvedValue({});
      prisma.emailVerificationToken.deleteMany.mockResolvedValue({});
      prisma.emailVerificationToken.create.mockResolvedValue({});

      const result = await service.register({
        email: ' Nueva@Cafe.com ',
        password: 'Naranja123!',
        organizationName: 'Café Nuevo',
      });

      expect(prisma.organization.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'Café Nuevo' }),
      });
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ email: 'nueva@cafe.com' }),
      });
      expect(prisma.membership.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          organizationId: 'org-1',
          roles: ['ADMIN'],
        },
      });
      expect(result.user).toMatchObject({ id: 'user-1' });
    });

    it('rechaza un correo ya registrado', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue({ id: 'user-1' });

      await expect(
        service.register({
          email: 'ocupado@cafe.com',
          password: 'Naranja123!',
          organizationName: 'Café',
        }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.organization.create).not.toHaveBeenCalled();
    });
  });

  describe('perfil y onboarding', () => {
    it('normaliza y guarda el nombre de usuario disponible', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(await userFixture({ username: null }))
        .mockResolvedValueOnce(null);
      prisma.user.update.mockResolvedValue({
        id: 'user-1',
        name: 'Ana Pérez',
        username: 'ana.perez',
      });

      const result = await service.updateProfile('user-1', {
        name: ' Ana Pérez ',
        username: ' Ana.Perez ',
      });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { name: 'Ana Pérez', username: 'ana.perez' },
      });
      expect(result).toMatchObject({ username: 'ana.perez' });
    });

    it('rechaza un nombre de usuario ya ocupado', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(await userFixture({ username: null }))
        .mockResolvedValueOnce({ id: 'otro-usuario' });

      await expect(
        service.updateProfile('user-1', { username: 'ana.perez' }),
      ).rejects.toBeInstanceOf(ConflictException);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('rechaza un nombre de usuario con formato inválido', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ username: null }),
      );

      await expect(
        service.updateProfile('user-1', { username: 'ana perez' }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it('marca el onboarding como completado', async () => {
      const { service, prisma } = createMocks();
      prisma.user.update.mockResolvedValue({});

      const result = await service.completeOnboarding('user-1');

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { onboardedAt: expect.any(Date) },
      });
      expect(result).toEqual({ onboarded: true });
    });

    it('me expone si el onboarding está completo', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ onboardedAt: new Date() }),
      );

      const result = await service.me('user-1');

      expect(result.onboarded).toBe(true);
    });
  });

  describe('login con Google', () => {
    const googleProfile = {
      sub: 'google-sub',
      email: 'admin@naranjapimienta.local',
      emailVerified: true,
      name: 'Admin',
    };

    it('crea el usuario, su negocio y una sesión al primer login', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(
          await userFixture({ email: 'nuevo@gmail.com', emailVerified: true }),
        );
      prisma.organization.create.mockResolvedValue({
        id: 'org-1',
        name: 'Negocio de Nuevo',
        slug: 'negocio-de-nuevo-abc123',
      });
      prisma.user.create.mockResolvedValue({ id: 'user-1' });
      prisma.membership.create.mockResolvedValue({});

      const result = await service.loginWithGoogle({
        ...googleProfile,
        email: 'nuevo@gmail.com',
      });

      expect(prisma.organization.create).toHaveBeenCalledTimes(1);
      expect(prisma.user.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          email: 'nuevo@gmail.com',
          googleId: 'google-sub',
          emailVerified: true,
        }),
      });
      expect(prisma.membership.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          organizationId: 'org-1',
          roles: ['ADMIN'],
        },
      });
      expect(result.kind).toBe('session');
      expect((result as { created?: boolean }).created).toBe(true);
      expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    });

    it('usa el nombre de negocio indicado desde el registro', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue(
          await userFixture({ email: 'nuevo@gmail.com', emailVerified: true }),
        );
      prisma.organization.create.mockResolvedValue({ id: 'org-1' });
      prisma.user.create.mockResolvedValue({ id: 'user-1' });
      prisma.membership.create.mockResolvedValue({});

      await service.loginWithGoogle(
        { ...googleProfile, email: 'nuevo@gmail.com' },
        {},
        { businessName: 'Café Central' },
      );

      expect(prisma.organization.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ name: 'Café Central' }),
      });
    });

    it('vincula la cuenta y emite sesión', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(await userFixture());
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.update.mockResolvedValue({});

      const result = await service.loginWithGoogle(googleProfile);

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-1', googleId: null },
        data: { googleId: 'google-sub' },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        data: { emailVerified: true },
      });
      expect(result.kind).toBe('session');
      expect(prisma.authSession.create).toHaveBeenCalledTimes(1);
    });

    it('respeta el 2FA activo y no entrega sesión', async () => {
      const { service, prisma, mail } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ twoFactorEnabled: true }),
      );
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.update.mockResolvedValue({});
      prisma.twoFactorCode.create.mockResolvedValue({});

      const result = await service.loginWithGoogle(googleProfile);

      expect(result.kind).toBe('twofactor');
      expect(mail.send).toHaveBeenCalledTimes(1);
      expect(prisma.authSession.create).not.toHaveBeenCalled();
    });

    it('rechaza una cuenta de Google distinta a la ya vinculada', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ googleId: 'otro-sub' }),
      );

      const result = await service.loginWithGoogle(googleProfile);

      expect(result).toEqual({ kind: 'error', reason: 'mismatch' });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('rechaza un correo de Google sin verificar', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(await userFixture());

      const result = await service.loginWithGoogle({
        ...googleProfile,
        emailVerified: false,
      });

      expect(result).toEqual({ kind: 'error', reason: 'unverified_email' });
      expect(prisma.authSession.create).not.toHaveBeenCalled();
    });

    it('rechaza usuarios desactivados', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ isActive: false }),
      );

      const result = await service.loginWithGoogle(googleProfile);

      expect(result).toEqual({ kind: 'error', reason: 'inactive' });
    });

    it('busca primero por googleId y no cae al correo', async () => {
      const { service, prisma } = createMocks();
      const user = await userFixture({
        googleId: 'google-sub',
        email: 'personal@gmail.com',
        emailVerified: true,
      });
      prisma.user.findUnique.mockResolvedValue(user);

      const result = await service.loginWithGoogle(googleProfile);

      expect(prisma.user.findUnique).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ where: { googleId: 'google-sub' } }),
      );
      expect(prisma.user.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'admin@naranjapimienta.local' } }),
      );
      expect(result.kind).toBe('session');
    });

    it('cae al correo cuando el googleId no está vinculado', async () => {
      const { service, prisma } = createMocks();
      const user = await userFixture();
      prisma.user.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValue(user);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      prisma.user.update.mockResolvedValue({});

      const result = await service.loginWithGoogle(googleProfile);

      expect(prisma.user.findUnique).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { email: 'admin@naranjapimienta.local' },
        }),
      );
      expect(result.kind).toBe('session');
    });
  });

  describe('vinculación de Google', () => {
    const googleProfile = {
      sub: 'google-sub',
      email: 'personal@gmail.com',
      emailVerified: true,
      name: 'Admin',
    };

    it('vincula la identidad a la cuenta autenticada', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(await userFixture({ googleId: null }))
        .mockResolvedValueOnce(null);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.linkGoogleAccount('user-1', googleProfile);

      expect(result).toEqual({ ok: true });
      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: 'user-1', googleId: null },
        data: { googleId: 'google-sub' },
      });
    });

    it('es idempotente si ya está vinculada con el mismo sub', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ googleId: 'google-sub' }),
      );

      const result = await service.linkGoogleAccount('user-1', googleProfile);

      expect(result).toEqual({ ok: true });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('no reemplaza una vinculación existente con otra cuenta', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ googleId: 'otro-sub' }),
      );

      const result = await service.linkGoogleAccount('user-1', googleProfile);

      expect(result).toEqual({ ok: false, reason: 'already_linked' });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('rechaza un sub que ya pertenece a otra cuenta', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique
        .mockResolvedValueOnce(await userFixture({ googleId: null }))
        .mockResolvedValueOnce({ id: 'user-2', googleId: 'google-sub' });

      const result = await service.linkGoogleAccount('user-1', googleProfile);

      expect(result).toEqual({ ok: false, reason: 'mismatch' });
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('rechaza correos de Google sin verificar', async () => {
      const { service, prisma } = createMocks();

      const result = await service.linkGoogleAccount('user-1', {
        ...googleProfile,
        emailVerified: false,
      });

      expect(result).toEqual({ ok: false, reason: 'unverified_email' });
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
    });

    it('rechaza vincular una cuenta inactiva', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ googleId: null, isActive: false }),
      );

      const result = await service.linkGoogleAccount('user-1', googleProfile);

      expect(result).toEqual({ ok: false, reason: 'inactive' });
    });
  });

  describe('userIdFromAccessToken', () => {
    it('devuelve el usuario de una sesión activa', async () => {
      const { service, prisma, jwt } = createMocks();
      jwt.verifyAsync.mockResolvedValue({ sid: 'session-1' });
      prisma.authSession.findUnique.mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60_000),
      });

      await expect(
        service.userIdFromAccessToken('access-token'),
      ).resolves.toBe('user-1');
    });

    it('devuelve null sin token, con token inválido o con sesión revocada', async () => {
      const { service, prisma, jwt } = createMocks();

      await expect(service.userIdFromAccessToken(undefined)).resolves.toBeNull();

      jwt.verifyAsync.mockRejectedValueOnce(new Error('invalid'));
      await expect(
        service.userIdFromAccessToken('bad-token'),
      ).resolves.toBeNull();

      jwt.verifyAsync.mockResolvedValueOnce({ sid: 'session-1' });
      prisma.authSession.findUnique.mockResolvedValueOnce({
        id: 'session-1',
        userId: 'user-1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        service.userIdFromAccessToken('revoked-token'),
      ).resolves.toBeNull();
    });
  });

  describe('me', () => {
    it('expone si la cuenta tiene Google vinculado', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ googleId: 'google-sub' }),
      );

      const result = await service.me('user-1');

      expect(result.googleLinked).toBe(true);
    });

    it('marca googleLinked en false sin vínculo', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue(
        await userFixture({ googleId: null }),
      );

      const result = await service.me('user-1');

      expect(result.googleLinked).toBe(false);
    });

    it('no expone el contador BigInt de almacenamiento en la sesión', async () => {
      const { service, prisma } = createMocks();
      prisma.user.findUnique.mockResolvedValue({
        ...(await userFixture()),
        memberships: [
          {
            roles: ['ADMIN'],
            organizationId: 'org-1',
            organization: {
              id: 'org-1',
              name: 'Naranja Pimienta',
              storageBytes: 1024n,
            },
          },
        ],
      });

      const result = await service.me('user-1');

      expect(result.organization).not.toHaveProperty('storageBytes');
      // Lo que sí serializa JSON debe seguir ahí.
      expect(result.organization).toMatchObject({ id: 'org-1' });
    });
  });
});
