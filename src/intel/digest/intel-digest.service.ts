import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role } from '@prisma/client';

import { ItemsService } from '../../catalog/items.service';
import { DashboardService } from '../../dashboard/dashboard.service';
import { MailService } from '../../mail/mail.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WasteService } from '../../waste/waste.service';

interface DigestLink {
  label: string;
  url: string;
}

interface DigestMetrics {
  sales: number;
  orders: number;
  averageTicket: number;
  lowStock: number;
  waste: number;
  kitchenRounds: number;
  averagePrepMinutes: number | null;
}

function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function money(value: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-MX', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Genera el digest diario de un negocio.
 *
 * Es determinista a propósito: los números salen de los mismos servicios que
 * usa la UI y el correo incluye enlaces a la evidencia. La narración queda
 * para el copiloto; el digest prioriza exactitud y bajo costo.
 */
@Injectable()
export class IntelDigestService {
  private readonly logger = new Logger(IntelDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dashboard: DashboardService,
    private readonly items: ItemsService,
    private readonly waste: WasteService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  async generateForAllOrganizations() {
    const organizations = await this.prisma.organization.findMany({
      where: { isActive: true, intelEnabled: true },
      select: { id: true },
    });

    let notifications = 0;
    let emailed = 0;

    for (const organization of organizations) {
      try {
        const result = await this.generateForOrganization(organization.id);
        notifications += result.notifications;
        emailed += result.emailed;
      } catch (error) {
        this.logger.warn(
          `Digest falló para ${organization.id}: ${
            error instanceof Error ? error.message : 'error desconocido'
          }`,
        );
      }
    }

    return {
      organizations: organizations.length,
      notifications,
      emailed,
    };
  }

  async generateForOrganization(organizationId: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { id: true, name: true, currency: true },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    const from = new Date();
    from.setDate(from.getDate() - 1);
    from.setHours(0, 0, 0, 0);

    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    to.setMilliseconds(-1);

    const [sales, inventory, kitchen, waste, costs] = await Promise.all([
      this.dashboard.salesReport(organizationId, from, to),
      this.dashboard.inventoryReport(organizationId, from, to),
      this.dashboard.kitchenReport(organizationId, from, to),
      this.waste.list(
        organizationId,
        null,
        from.toISOString(),
        to.toISOString(),
      ),
      this.items.foodCost(organizationId, 0.35),
    ]);

    const lowMargin = costs.items
      .filter((row) => row.complete)
      .sort((a, b) => a.marginPct - b.marginPct)
      .slice(0, 3);

    const wasteTop = waste.byReason
      .slice()
      .sort((a, b) => b.cost - a.cost)[0];

    const lines = [
      `Resumen diario — ${this.dateLabel(from)}`,
      '',
      `Ventas: ${money(sales.totals.sales, organization.currency)} en ${sales.totals.orders} pedidos (ticket promedio ${money(sales.totals.averageTicket, organization.currency)}).`,
      sales.topItems.length
        ? `Top platillos: ${sales.topItems
            .slice(0, 3)
            .map((item) => `${item.name} (${item.quantity})`)
            .join(', ')}.`
        : 'Top platillos: sin ventas registradas.',
      inventory.lowStock.length
        ? `Stock bajo: ${inventory.lowStock.length} insumo(s). ${inventory.lowStock
            .slice(0, 3)
            .map(
              (item) =>
                `${item.name} (faltan ${item.deficit} ${item.displayUnit})`,
            )
            .join(', ')}.`
        : 'Stock bajo: sin insumos bajo mínimo.',
      waste.total > 0
        ? `Mermas: ${money(waste.total, organization.currency)}${wasteTop ? `; principal motivo ${wasteTop.reason} (${money(wasteTop.cost, organization.currency)})` : ''}.`
        : 'Mermas: sin registros.',
      kitchen.totals.rounds > 0
        ? `Cocina: ${kitchen.totals.rounds} rondas; preparación promedio ${kitchen.totals.averagePrepMinutes ?? 's/d'} min; ${Math.round((kitchen.totals.withinEstimateRate ?? 0) * 100)}% dentro del estimado.`
        : 'Cocina: sin rondas registradas.',
      lowMargin.length
        ? `Márgenes bajos: ${lowMargin
            .map(
              (row) =>
                `${row.name} (${Math.round(row.marginPct * 100)}% margen)`,
            )
            .join(', ')}.`
        : 'Márgenes bajos: sin recetas completas.',
    ];

    const body = lines.join('\n');
    const title = `Resumen diario — ${this.dateLabel(from)}`;
    const links: DigestLink[] = [
      { label: 'Ventas', url: '/reports' },
      { label: 'Food cost', url: '/reports/food-cost' },
      { label: 'Inventario', url: '/inventory' },
      { label: 'Merma', url: '/waste' },
      { label: 'Cocina', url: '/kitchen' },
      { label: 'Copiloto', url: '/intel' },
    ];
    const metrics: DigestMetrics = {
      sales: sales.totals.sales,
      orders: sales.totals.orders,
      averageTicket: sales.totals.averageTicket,
      lowStock: inventory.lowStock.length,
      waste: waste.total,
      kitchenRounds: kitchen.totals.rounds,
      averagePrepMinutes: kitchen.totals.averagePrepMinutes,
    };

    const recipients = await this.recipientsFor(organizationId);
    const html = this.renderHtml({
      organizationName: organization.name,
      title,
      body,
      links,
    });
    const text = `${body}\n\n${links
      .map((link) => `${link.label}: ${this.webUrl()}${link.url}`)
      .join('\n')}`;

    let notifications = 0;
    let emailed = 0;

    if (recipients.length === 0) {
      await this.prisma.aiNotification.create({
        data: {
          organizationId,
          kind: 'DIGEST',
          title,
          body,
          data: { links, metrics } as never,
        },
      });
      notifications += 1;
    }

    for (const recipient of recipients) {
      const notification = await this.prisma.aiNotification.create({
        data: {
          organizationId,
          userId: recipient.userId,
          kind: 'DIGEST',
          title,
          body,
          data: { links, metrics } as never,
        },
      });
      notifications += 1;

      if (recipient.email) {
        try {
          await this.mail.send({
            to: recipient.email,
            subject: title,
            html,
            text,
          });
          await this.prisma.aiNotification.update({
            where: { id: notification.id },
            data: { emailedAt: new Date() },
          });
          emailed += 1;
        } catch (error) {
          this.logger.warn(
            `No se pudo enviar el digest a ${recipient.email}: ${
              error instanceof Error ? error.message : 'error desconocido'
            }`,
          );
        }
      }
    }

    return {
      organizationId,
      notifications,
      emailed,
      recipients: recipients.length,
    };
  }

  private async recipientsFor(organizationId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: {
        organizationId,
        isActive: true,
        roles: {
          hasSome: [Role.ADMIN, Role.INVENTORY_MANAGER, Role.SUPERVISOR],
        },
        user: { is: { isActive: true, email: { not: null } } },
      },
      select: {
        userId: true,
        user: { select: { email: true } },
      },
    });

    const seen = new Set<string>();

    return memberships
      .filter((membership) => {
        if (seen.has(membership.userId)) return false;
        seen.add(membership.userId);
        return true;
      })
      .map((membership) => ({
        userId: membership.userId,
        email: membership.user.email,
      }));
  }

  private renderHtml(input: {
    organizationName: string;
    title: string;
    body: string;
    links: DigestLink[];
  }) {
    const webUrl = this.webUrl();

    return [
      '<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;line-height:1.5;color:#111;max-width:640px;margin:0 auto">',
      `<h1 style="font-size:20px;margin:0 0 4px">${escapeHtml(input.title)}</h1>`,
      `<p style="margin:0 0 16px;color:#555">${escapeHtml(input.organizationName)}</p>`,
      `<pre style="white-space:pre-wrap;font-family:inherit;font-size:14px;background:#f6f6f6;padding:16px;border-radius:12px;margin:0 0 16px">${escapeHtml(input.body)}</pre>`,
      '<p style="font-size:14px;margin:0 0 8px">Ver la evidencia:</p>',
      '<ul style="padding-left:20px;margin:0 0 16px">',
      ...input.links.map(
        (link) =>
          `<li style="margin:4px 0"><a href="${webUrl}${link.url}" style="color:#0a66c2">${escapeHtml(link.label)}</a></li>`,
      ),
      '</ul>',
      '<p style="font-size:12px;color:#777;margin:0">Generado por Mishef Intel.</p>',
      '</div>',
    ].join('');
  }

  private dateLabel(date: Date): string {
    return new Intl.DateTimeFormat('es-MX', {
      dateStyle: 'long',
    }).format(date);
  }

  private webUrl(): string {
    return (
      this.config.get<string>('WEB_ORIGIN') ?? 'http://localhost:3000'
    ).replace(/\/$/, '');
  }
}
