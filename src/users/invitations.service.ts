import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';
import { hash } from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { CreateInvitationDto } from './dto/create-invitation.dto';
import {
  isValidUsername,
  normalizeUsername,
  usernameCandidates,
} from '../common/usernames';

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** `ana@cafe.com` → `an***@cafe.com`, para no filtrar el correo en la vista previa. */
function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}${'*'.repeat(Math.max(1, user.length - visible.length))}@${domain}`;
}

export interface InvitationPreview {
  organizationName: string;
  organizationSlug: string;
  email: string;
  name: string | null;
  username: string | null;
  roles: Role[];
  expiresAt: string;
  alreadyHasAccount: boolean;
}

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  private get webOrigin(): string {
    return (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
  }

  private link(token: string): string {
    return `${this.webOrigin}/join/${token}`;
  }

  async create(
    organizationId: string | null,
    actorId: string,
    dto: CreateInvitationDto,
  ) {
    if (!organizationId) {
      throw new NotFoundException('Organización no encontrada');
    }

    const email = dto.email.trim().toLowerCase();
    const roles = dto.roles?.length ? dto.roles : [Role.WAITER];
    const name = dto.name?.trim() || null;
    const username = dto.username ? normalizeUsername(dto.username) : null;

    if (username && !isValidUsername(username)) {
      throw new BadRequestException(
        'El nombre de usuario no es válido: usa entre 3 y 32 caracteres, sin @dominio',
      );
    }

    if (username) {
      const usernameTaken = await this.prisma.membership.findFirst({
        where: { organizationId, username },
        select: { id: true },
      });

      if (usernameTaken) {
        throw new ConflictException(
          'Ese nombre de usuario ya está en uso en este negocio',
        );
      }
    }

    const effectiveUsername =
      username ??
      (await this.resolveInvitationUsername({
        organizationId,
        email,
        name,
        username: null,
      }));

    const alreadyMember = await this.prisma.membership.findFirst({
      where: {
        organizationId,
        user: { email },
      },
      select: { id: true },
    });

    if (alreadyMember) {
      throw new ConflictException('Esa persona ya pertenece al equipo');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { name: true, slug: true, brandColor: true },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    // Una invitación pendiente por correo: se reemplaza la anterior.
    await this.prisma.invitation.deleteMany({
      where: { organizationId, email, acceptedAt: null },
    });

    const token = newToken();

    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId,
        email,
        name,
        username: effectiveUsername,
        roles,
        branchId: dto.branchId ?? null,
        tokenHash: hashToken(token),
        invitedById: actorId,
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
      },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        roles: true,
        expiresAt: true,
      },
    });

    const link = this.link(token);
    const accent = organization.brandColor ?? '#e2703a';

    await this.mail.send({
      to: email,
      subject: `${organization.name} te invitó a Mishef`,
      text: [
        `${organization.name} te invitó a su equipo en Mishef.`,
        '',
        `Tu usuario será: ${effectiveUsername}`,
        `Acepta la invitación aquí: ${link}`,
        '',
        'El enlace caduca en 7 días.',
      ].join('\n'),
      html: `
        <div style="font-family:system-ui,sans-serif;max-width:520px">
          <h2 style="margin:0 0 12px">Te invitaron a ${organization.name}</h2>
          <p style="color:#444;line-height:1.6">
            ${organization.name} te agregó a su equipo en Mishef, el punto de
            venta para cafeterías y restaurantes.
          </p>
          <p style="color:#444;line-height:1.6">
            Tu usuario será <strong>${effectiveUsername}</strong>. Podrás
            elegir tu contraseña al aceptar.
          </p>
          <p style="margin:24px 0">
            <a href="${link}"
               style="background:${accent};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">
              Aceptar invitación
            </a>
          </p>
          <p style="color:#888;font-size:13px">
            El enlace caduca en 7 días. Si no esperabas esta invitación, ignora
            este correo.
          </p>
        </div>
      `,
    });

    return { ...invitation, link };
  }

  async list(organizationId: string | null) {
    if (!organizationId) return [];

    return this.prisma.invitation.findMany({
      where: {
        organizationId,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        email: true,
        name: true,
        username: true,
        roles: true,
        expiresAt: true,
        createdAt: true,
      },
    });
  }

  async cancel(organizationId: string | null, id: string) {
    const result = await this.prisma.invitation.deleteMany({
      where: { id, organizationId: organizationId ?? '__none__' },
    });

    if (result.count === 0) {
      throw new NotFoundException('Invitación no encontrada');
    }

    return { ok: true };
  }

  /** Vista previa pública: lo mínimo para que la persona sepa qué acepta. */
  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.findValid(token);

    const user = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true },
    });

    return {
      organizationName: invitation.organization.name,
      organizationSlug: invitation.organization.slug,
      email: maskEmail(invitation.email),
      name: invitation.name,
      username: invitation.username,
      roles: invitation.roles,
      expiresAt: invitation.expiresAt.toISOString(),
      alreadyHasAccount: Boolean(user),
    };
  }

  /**
   * Canjea la invitación.
   *
   * Si el correo ya tiene cuenta, solo se agrega la membresía (la contraseña
   * enviada se ignora). Si no, se crea la cuenta ya verificada: poseer el
   * enlace demuestra control del correo.
   */
  async accept(token: string, dto: AcceptInvitationDto) {
    const invitation = await this.findValid(token);

    const existingUser = await this.prisma.user.findUnique({
      where: { email: invitation.email },
      select: { id: true, passwordHash: true },
    });

    if (existingUser) {
      const membership = await this.prisma.membership.findFirst({
        where: {
          userId: existingUser.id,
          organizationId: invitation.organizationId,
        },
        select: { id: true },
      });

      if (membership) {
        throw new ConflictException('Ya perteneces a este equipo');
      }

      await this.assertUserLimit(invitation.organizationId);
      const username = await this.resolveInvitationUsername(invitation);

      await this.prisma.$transaction([
        this.prisma.membership.create({
          data: {
            userId: existingUser.id,
            organizationId: invitation.organizationId,
            username,
            roles: invitation.roles,
            branchId: invitation.branchId,
          },
        }),
        this.prisma.invitation.update({
          where: { id: invitation.id },
          data: { acceptedAt: new Date() },
        }),
      ]);

      return {
        ok: true,
        organizationSlug: invitation.organization.slug,
        username,
        alreadyHadAccount: true,
      };
    }

    if (!dto.password || dto.password.length < 8) {
      throw new BadRequestException(
        'Necesitas una contraseña de al menos 8 caracteres',
      );
    }

    const passwordHash = await hash(dto.password);
    const username = await this.resolveInvitationUsername(invitation);

    await this.assertUserLimit(invitation.organizationId);

    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: invitation.email,
          passwordHash,
          name: dto.name?.trim() || invitation.name || null,
          username,
          emailVerified: true,
          mustChangePassword: false,
        },
      });

      await tx.membership.create({
        data: {
          userId: user.id,
          organizationId: invitation.organizationId,
          username,
          roles: invitation.roles,
          branchId: invitation.branchId,
        },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });
    });

    return {
      ok: true,
      organizationSlug: invitation.organization.slug,
      username,
      alreadyHadAccount: false,
    };
  }

  private async resolveInvitationUsername(invitation: {
    organizationId: string;
    email: string;
    name: string | null;
    username: string | null;
  }): Promise<string> {
    const desired = invitation.username
      ? normalizeUsername(invitation.username)
      : null;
    const fallback =
      invitation.name?.trim() ||
      invitation.email.split('@')[0] ||
      'usuario';

    const candidates = desired
      ? [
          desired,
          ...Array.from({ length: 9 }, (_value, index) => `${desired}${index + 2}`),
        ]
      : usernameCandidates(fallback);

    if (candidates.length === 0) {
      throw new BadRequestException(
        'No pudimos proponer un nombre de usuario para la invitación',
      );
    }

    const taken = await this.prisma.membership.findMany({
      where: {
        organizationId: invitation.organizationId,
        username: { in: candidates },
      },
      select: { username: true },
    });
    const takenSet = new Set(taken.map((member) => member.username));
    const chosen = candidates.find((candidate) => !takenSet.has(candidate));

    if (!chosen) {
      throw new ConflictException(
        'No hay un nombre de usuario disponible para esta invitación',
      );
    }

    // Un username explícito no se cambia en silencio: el administrador debe
    // corregir la invitación si ya se ocupó.
    if (desired && chosen !== desired) {
      throw new ConflictException(
        'El nombre de usuario de la invitación ya está ocupado. Pide una nueva invitación.',
      );
    }

    return chosen;
  }

  private async assertUserLimit(organizationId: string) {
    if (!this.prisma.organizationSubscription) return;

    const [subscription, users, branches] = await Promise.all([
      this.prisma.organizationSubscription.findUnique({
        where: { organizationId },
        include: { plan: true },
      }),
      this.prisma.membership.count({
        where: { organizationId, isActive: true, user: { isActive: true } },
      }),
      this.prisma.branch.count({ where: { organizationId, isActive: true } }),
    ]);

    const perBranch = subscription?.plan.maxUsersPerBranch;
    if (perBranch === null || perBranch === undefined) return;

    const limit = perBranch * Math.max(1, branches);

    if (users >= limit) {
      throw new BadRequestException(
        `Tu plan permite hasta ${limit} usuario(s) activo(s). Cambia de plan para agregar más.`,
      );
    }
  }

  private async findValid(token: string) {
    if (!token || token.length > 200) {
      throw new NotFoundException('Invitación no válida');
    }

    const invitation = await this.prisma.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { organization: { select: { name: true, slug: true } } },
    });

    if (!invitation) {
      throw new NotFoundException('Invitación no válida');
    }

    if (invitation.acceptedAt) {
      throw new BadRequestException('Esta invitación ya fue utilizada');
    }

    if (invitation.expiresAt <= new Date()) {
      throw new BadRequestException('Esta invitación caducó');
    }

    return invitation;
  }
}
