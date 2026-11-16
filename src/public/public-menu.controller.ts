import { Controller, Get, NotFoundException, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { publicUrlForKey } from '../uploads/r2';

interface MenuItemView {
  id: string;
  name: string;
  description: string | null;
  price: number;
  imageUrl: string | null;
}

/**
 * Menú digital público.
 *
 * Es la carta que ve el comensal en `slug.mishef.co/menu` o en el dominio
 * propio del negocio (`midominio.com/menu`). Solo expone nombre, descripción,
 * precio e imagen de los artículos activos: nada de costos, stock ni ventas.
 */
@ApiTags('public')
@Controller('public/menu')
export class PublicMenuController {
  constructor(private readonly prisma: PrismaService) {}

  @ApiOperation({ summary: 'Menú público del negocio' })
  @Get()
  async menu(@Query('host') host?: string, @Query('slug') slug?: string) {
    const organization = await this.resolveOrganization(host, slug);

    const menus = await this.prisma.menu.findMany({
      where: { organizationId: organization.id, isActive: true },
      orderBy: [{ isGlobal: 'desc' }, { sortOrder: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        groups: true,
        items: {
          orderBy: { sortOrder: 'asc' },
          select: {
            group: true,
            item: {
              select: {
                id: true,
                name: true,
                description: true,
                price: true,
                isActive: true,
                catalogEntry: { select: { imageKey: true } },
              },
            },
          },
        },
      },
    });

    return {
      organization: {
        name: organization.name,
        slug: organization.slug,
        brandColor: organization.brandColor,
        logoUrl: organization.logoUrl,
        address: organization.address,
      },
      menus: menus
        .map((menu) => {
          const groups = new Map<string, MenuItemView[]>();

          for (const row of menu.items) {
            if (!row.item.isActive) continue;

            const group = row.group?.trim() || 'Sin grupo';
            const list = groups.get(group) ?? [];

            list.push({
              id: row.item.id,
              name: row.item.name,
              description: row.item.description,
              price: Number(row.item.price),
              imageUrl: row.item.catalogEntry?.imageKey
                ? publicUrlForKey(row.item.catalogEntry.imageKey)
                : null,
            });

            groups.set(group, list);
          }

          // Respeta el orden de secciones definido en el menú; el resto va al
          // final por orden alfabético.
          const ordered = [
            ...menu.groups.filter((group) => groups.has(group)),
            ...[...groups.keys()]
              .filter((group) => !menu.groups.includes(group))
              .sort((a, b) => a.localeCompare(b, 'es')),
          ];

          return {
            id: menu.id,
            name: menu.name,
            description: menu.description,
            groups: ordered.map((group) => ({
              name: group,
              items: groups.get(group) ?? [],
            })),
          };
        })
        .filter((menu) => menu.groups.length > 0),
    };
  }

  private async resolveOrganization(host?: string, slug?: string) {
    const cleanHost = host?.trim().toLowerCase().replace(/:\d+$/, '');
    const cleanSlug = slug?.trim().toLowerCase();

    const organization = cleanSlug
      ? await this.prisma.organization.findFirst({
          where: { slug: cleanSlug, isActive: true },
          select: {
            id: true,
            name: true,
            slug: true,
            brandColor: true,
            logoUrl: true,
            address: true,
          },
        })
      : cleanHost
        ? await this.prisma.organization.findFirst({
            where: {
              domain: cleanHost,
              domainVerifiedAt: { not: null },
              isActive: true,
            },
            select: {
              id: true,
              name: true,
              slug: true,
              brandColor: true,
              logoUrl: true,
              address: true,
            },
          })
        : null;

    if (!organization) {
      throw new NotFoundException('Negocio no encontrado');
    }

    return organization;
  }
}
