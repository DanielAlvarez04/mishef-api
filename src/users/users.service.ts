import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { hash } from 'argon2';
import { Role } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { sameStringSet } from '../common/patch';
import {
  isValidUsername,
  normalizeUsername,
  usernameCandidates,
} from '../common/usernames';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';

const userSelect = {
  id: true,
  email: true,
  username: true,
  name: true,
  isActive: true,
  emailVerified: true,
  twoFactorEnabled: true,
  googleId: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string | null) {
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId },
      include: {
        user: { select: userSelect },
        branch: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return memberships.map((membership) => ({
      id: membership.user.id,
      email: membership.user.email,
      username: membership.user.username,
      name: membership.user.name,
      isActive: membership.isActive && membership.user.isActive,
      emailVerified: membership.user.emailVerified,
      twoFactorEnabled: membership.user.twoFactorEnabled,
      googleLinked: Boolean(membership.user.googleId),
      roles: membership.roles,
      branchId: membership.branchId,
      branchName: membership.branch?.name ?? null,
      createdAt: membership.createdAt,
    }));
  }

  /**
   * Comprueba si un nombre de usuario se puede usar.
   *
   * Devuelve `reason: 'invalid'` cuando no cumple el formato, para que el
   * formulario muestre el mismo mensaje sin depender de un 400.
   */
  async usernameAvailable(rawUsername: string) {
    const username = normalizeUsername(rawUsername ?? '');

    if (!isValidUsername(username)) {
      return { username, available: false, reason: 'invalid' as const };
    }

    const existing = await this.prisma.user.findUnique({
      where: { username },
    });

    if (existing) {
      return { username, available: false, reason: 'taken' as const };
    }

    return { username, available: true };
  }

  /**
   * Busca un usuario por correo para precargar su nombre.
   *
   * Se usa cuando el administrador crea un usuario interno y el correo ya
   * pertenece a una cuenta existente (registro con correo o Google), de modo
   * que nombre y apellido se completen automáticamente.
   */
  async findByEmail(email: string) {
    const normalized = email.trim().toLowerCase();

    if (!normalized) {
      return { found: false };
    }

    const user = await this.prisma.user.findUnique({
      where: { email: normalized },
      select: { id: true, name: true, email: true, username: true },
    });

    if (!user) {
      return { found: false };
    }

    return { found: true, name: user.name, email: user.email, username: user.username };
  }

  /**
   * Propone el usuario para una cuenta nueva.
   *
   * Usa el dominio del negocio: `ana@naranjapimienta.cafe`; si ya existe, cae
   * en `a.perez@naranjapimienta.cafe` y, si también, añade un número. Sin
   * dominio configurado mantiene el formato antiguo (`ana`, `a.perez`).
   */
  async suggestUsername(organizationId: string | null, rawName: string) {
    if (!organizationId) {
      return { username: '', domain: null };
    }
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { domain: true },
    });

    const domain = organization?.domain ?? null;
    const candidates = usernameCandidates(rawName?.trim() ?? '', domain);

    if (candidates.length === 0) {
      return { username: '', domain };
    }

    const taken = await this.prisma.user.findMany({
      where: { username: { in: candidates } },
      select: { username: true },
    });
    const takenUsernames = new Set(taken.map((user) => user.username));
    const username =
      candidates.find((candidate) => !takenUsernames.has(candidate)) ??
      candidates[candidates.length - 1];

    return { username, domain };
  }

  /**
   * Crea una cuenta interna para un empleado.
   *
   * El acceso es por usuario + contraseña; el correo es opcional y sólo se usa
   * para 2FA y recuperación. No se reutilizan cuentas de otras organizaciones.
   */
  async create(organizationId: string | null, dto: CreateUserDto) {
    const username = normalizeUsername(dto.username);

    if (!isValidUsername(username)) {
      throw new BadRequestException('El nombre de usuario no es válido');
    }

    const email = dto.email?.trim().toLowerCase() || null;

    const [usernameTaken, emailTaken] = await Promise.all([
      this.prisma.user.findUnique({ where: { username } }),
      email ? this.prisma.user.findUnique({ where: { email } }) : null,
    ]);

    if (usernameTaken) {
      throw new ConflictException('Ese nombre de usuario ya está en uso');
    }

    if (emailTaken) {
      throw new ConflictException('Ese correo ya está registrado');
    }

    const passwordHash = await hash(dto.password);

    // Combinar nombre y apellido para guardar en el campo `name`
    const fullName = [dto.name?.trim(), dto.surname?.trim()].filter(Boolean).join(' ');
    const branchId = await this.resolveBranchId(organizationId, dto.branchId);

    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          username,
          email,
          name: fullName || null,
          passwordHash,
          // El ADMIN que crea la cuenta responde por el correo indicado.
          emailVerified: Boolean(email),
          // La cuenta interna ya queda configurada; no pasa por el onboarding.
          onboardedAt: new Date(),
        },
      });

      const membership = await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: organizationId,
          branchId,
          roles: dto.roles,
        },
      });

      return {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
        roles: membership.roles,
        branchId: membership.branchId,
        googleLinked: false,
      };
    });
  }

  async update(
    organizationId: string | null,
    userId: string,
    dto: UpdateUserDto,
    actorId: string,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Usuario no encontrado en la organización');
    }
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: { user: { select: userSelect } },
    });

    if (!membership) {
      throw new NotFoundException('Usuario no encontrado en la organización');
    }

    if (userId === actorId && dto.isActive === false) {
      throw new BadRequestException('No puedes desactivar tu propia cuenta');
    }

    if (
      userId === actorId &&
      dto.roles &&
      !dto.roles.includes(Role.ADMIN)
    ) {
      throw new BadRequestException(
        'No puedes quitarte el rol de administrador',
      );
    }

    const losesAdmin =
      membership.roles.includes(Role.ADMIN) &&
      dto.roles !== undefined &&
      !dto.roles.includes(Role.ADMIN);

    if (losesAdmin) {
      await this.assertAnotherAdminExists(organizationId, userId);
    }

    if (dto.isActive === false && membership.isActive) {
      await this.assertNotLastActiveAdmin(organizationId, membership);
    }

    const passwordHash = dto.password ? await hash(dto.password) : undefined;
    const branchId =
      dto.branchId !== undefined
        ? await this.resolveBranchId(organizationId, dto.branchId)
        : undefined;

    // El nombre visible se compone de nombre + apellido, igual que en el alta.
    // Si solo llega el apellido, se conserva el nombre de pila actual.
    const nameChanged = dto.name !== undefined || dto.surname !== undefined;
    const currentGivenName = (membership.user.name ?? '').trim().split(/\s+/)[0] ?? '';
    const nextName = nameChanged
      ? [dto.name !== undefined ? dto.name : currentGivenName, dto.surname]
          .map((part) => part?.trim())
          .filter(Boolean)
          .join(' ') || null
      : undefined;

    const nameIsDifferent =
      nextName !== undefined && nextName !== membership.user.name;
    const rolesChanged =
      dto.roles !== undefined && !sameStringSet(membership.roles, dto.roles);
    const isActiveChanged =
      dto.isActive !== undefined && dto.isActive !== membership.isActive;
    const branchChanged =
      branchId !== undefined && branchId !== membership.branchId;

    // Si no cambió nada, no se escribe ni se revocan sesiones.
    if (
      !nameIsDifferent &&
      !passwordHash &&
      !rolesChanged &&
      !isActiveChanged &&
      !branchChanged
    ) {
      return {
        id: userId,
        username: membership.user.username,
        email: membership.user.email,
        name: membership.user.name,
        roles: membership.roles,
        branchId: membership.branchId,
        isActive: membership.isActive,
      };
    }

    return this.prisma.$transaction(async (tx) => {
      if (nameIsDifferent || passwordHash) {
        await tx.user.update({
          where: { id: userId },
          data: {
            ...(nameIsDifferent ? { name: nextName } : {}),
            ...(passwordHash ? { passwordHash } : {}),
          },
        });
      }

      if (passwordHash) {
        await tx.authSession.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
        });
      }

      const updated =
        rolesChanged || isActiveChanged || branchChanged
          ? await tx.membership.update({
              where: { id: membership.id },
              data: {
                ...(rolesChanged ? { roles: dto.roles } : {}),
                ...(isActiveChanged ? { isActive: dto.isActive } : {}),
                ...(branchChanged ? { branchId } : {}),
              },
            })
          : membership;

      return {
        id: userId,
        username: membership.user.username,
        email: membership.user.email,
        name: nameIsDifferent ? nextName : membership.user.name,
        roles: updated.roles,
        branchId: updated.branchId,
        isActive: updated.isActive,
      };
    });
  }

  async deactivate(organizationId: string | null, userId: string, actorId: string) {
    if (!organizationId) {
      throw new NotFoundException('Usuario no encontrado en la organización');
    }
    if (userId === actorId) {
      throw new BadRequestException('No puedes desactivar tu propia cuenta');
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: { user: { select: userSelect } },
    });

    if (!membership) {
      throw new NotFoundException('Usuario no encontrado en la organización');
    }

    await this.assertNotLastActiveAdmin(organizationId, membership);

    await this.prisma.membership.update({
      where: { id: membership.id },
      data: { isActive: false },
    });

    await this.prisma.authSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'USER_DEACTIVATED' },
    });

    return { ok: true };
  }

  /**
   * Elimina un usuario de la organización (hard delete).
   *
   * Si la organización era la única a la que pertenecía, se borra la cuenta
   * (`User`) completa; si pertenece a otras, solo se borra esta membresía. En
   * ambos casos se conservan los registros que haya creado (pedidos, pagos,
   * movimientos de inventario, auditoría): sus claves foráneas quedan en
   * `NULL` vía `onDelete: SetNull`, nunca en cascada.
   */
  async deleteMembership(organizationId: string | null, userId: string, actorId: string) {
    if (!organizationId) {
      throw new NotFoundException('Usuario no encontrado en la organización');
    }
    if (userId === actorId) {
      throw new BadRequestException('No puedes eliminarte a ti mismo de la organización');
    }

    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: { user: { select: userSelect } },
    });

    if (!membership) {
      throw new NotFoundException('Usuario no encontrado en la organización');
    }

    await this.assertNotLastActiveAdmin(organizationId, membership);

    await this.removeAccountOrMembership(userId, membership.id);

    return { ok: true };
  }

  /**
   * Elimina varias cuentas de la organización de una sola vez (hard delete).
   *
   * Se salta al propio actor y a los usuarios que ya no pertenecen a la
   * organización; el resto se borra con las mismas reglas que
   * `deleteMembership`.
   */
  async deleteMemberships(
    organizationId: string | null,
    userIds: string[],
    actorId: string,
  ) {
    if (!organizationId) {
      return { ok: true, deletedCount: 0 };
    }
    const targets = [...new Set(userIds)].filter((userId) => userId !== actorId);
    let deletedCount = 0;

    for (const userId of targets) {
      const membership = await this.prisma.membership.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
      });

      if (!membership) continue;

      await this.assertNotLastActiveAdmin(organizationId, membership);
      await this.removeAccountOrMembership(userId, membership.id);
      deletedCount += 1;
    }

    return { ok: true, deletedCount };
  }

  /**
   * Borra la cuenta completa o solo la membresía, según corresponda.
   *
   * Al borrar `User` se eliminan también sus sesiones, tokens y membresías
   * (cascada), pero los pedidos, pagos, kardex y auditoría sobreviven.
   */
  private async removeAccountOrMembership(userId: string, membershipId: string) {
    const otherMemberships = await this.prisma.membership.count({
      where: { userId, id: { not: membershipId } },
    });

    await this.prisma.$transaction(async (tx) => {
      if (otherMemberships === 0) {
        await tx.user.delete({ where: { id: userId } });
        return;
      }

      await tx.authSession.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'MEMBERSHIP_DELETED' },
      });

      await tx.membership.delete({ where: { id: membershipId } });
    });
  }

  /**
   * Purgar usuarios desactivados: hard delete de sus cuentas (o de la
   * membresía si siguen perteneciendo a otra organización).
   *
   * Los pedidos, pagos, movimientos y auditoría que crearon se conservan.
   */
  async purgeDeletedUsers(organizationId: string | null) {
    if (!organizationId) {
      return { ok: true, deletedCount: 0 };
    }
    const memberships = await this.prisma.membership.findMany({
      where: { organizationId, isActive: false },
      select: { id: true, userId: true },
    });

    for (const membership of memberships) {
      await this.removeAccountOrMembership(membership.userId, membership.id);
    }

    return { ok: true, deletedCount: memberships.length };
  }

  /** Valida que la sucursal pertenezca a la organización y esté activa. */
  private async resolveBranchId(
    organizationId: string | null,
    raw?: string,
  ): Promise<string | null> {
    const value = raw?.trim();

    if (!value) {
      return null;
    }

    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: value, organizationId, isActive: true },
      select: { id: true },
    });

    if (!branch) {
      throw new BadRequestException('La sucursal no existe o está inactiva');
    }

    return branch.id;
  }

  private async assertAnotherAdminExists(
    organizationId: string | null,
    excludeUserId: string,
  ) {
    if (!organizationId) {
      throw new BadRequestException('La organización debe conservar al menos un administrador activo');
    }
    const admins = await this.prisma.membership.count({
      where: {
        organizationId,
        isActive: true,
        roles: { has: Role.ADMIN },
        userId: { not: excludeUserId },
      },
    });

    if (admins === 0) {
      throw new BadRequestException(
        'La organización debe conservar al menos un administrador activo',
      );
    }
  }

  private async assertNotLastActiveAdmin(
    organizationId: string | null,
    membership: { userId: string; roles: Role[] },
  ) {
    if (!membership.roles.includes(Role.ADMIN)) {
      return;
    }

    await this.assertAnotherAdminExists(organizationId, membership.userId);
  }
}
