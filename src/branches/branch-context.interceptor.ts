import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

interface RequestWithUser {
  user?: {
    sub: string;
    organizationId: string | null;
  };
  headers: Record<string, string | string[] | undefined>;
  branchId?: string | null;
}

/** Cookie que el panel web usa para recordar la sucursal activa. */
const BRANCH_COOKIE = 'np_branch';

/**
 * Resuelve la sucursal activa de la petición a partir de `x-branch-id` o, si
 * la petición viene del navegador, de la cookie `np_branch`.
 *
 * Reglas:
 * - Sin sucursal: contexto de organización completa (`branchId = null`).
 * - Con sucursal: debe pertenecer a la organización, estar activa y, si la
 *   membresía tiene una sucursal asignada, debe coincidir con ella.
 *
 * El resultado queda en `request.branchId` y lo expone `@CurrentBranch()`.
 */
@Injectable()
export class BranchContextInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    request.branchId = null;

    const header = request.headers['x-branch-id'];
    const raw = Array.isArray(header) ? header[0] : header;
    const requested =
      raw?.trim() || readCookie(request.headers.cookie, BRANCH_COOKIE);

    if (!request.user?.organizationId) {
      return next.handle();
    }

    const organizationId = request.user.organizationId;
    const membership = await this.prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: request.user.sub,
          organizationId,
        },
      },
      select: { isActive: true, branchId: true },
    });

    if (!membership?.isActive) {
      throw new ForbiddenException('Tu acceso a la organización está inactivo');
    }

    // Quien está asignado a una sucursal opera siempre dentro de ella, aunque
    // borre la cookie o pida el consolidado.
    if (membership.branchId) {
      request.branchId = membership.branchId;
      return next.handle();
    }

    if (!requested) {
      return next.handle();
    }

    const branch = await this.prisma.branch.findFirst({
      where: { id: requested, organizationId, isActive: true },
      select: { id: true },
    });

    if (!branch) {
      // La sucursal pudo eliminarse o desactivarse (p. ej. al limpiar datos de
      // prueba). Se ignora y se opera en el consolidado en lugar de romper la
      // sesión: `/auth/me` y el resto de peticiones fallarían igual y
      // provocarían un bucle /dashboard ↔ /login.
      return next.handle();
    }

    request.branchId = branch.id;

    return next.handle();
  }
}

/** Lee una cookie del encabezado `cookie` sin dependencias externas. */
function readCookie(
  header: string | string[] | undefined,
  name: string,
): string | undefined {
  const value = Array.isArray(header) ? header.join('; ') : header;

  if (!value) {
    return undefined;
  }

  for (const part of value.split(';')) {
    const index = part.indexOf('=');

    if (index === -1) continue;

    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim()) || undefined;
    }
  }

  return undefined;
}
