import { Injectable } from '@nestjs/common';
import { KitchenMode, KitchenTicketStatus, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';

interface RoundItemRef {
  id: string;
  itemId: string;
}

/**
 * Crea los tickets de estación de una ronda cuando la sucursal opera en modo
 * Avanzado.
 *
 * La resolución de estación sigue el orden acordado:
 * artículo (`Item.defaultStationId`) → regla de artículo → regla de categoría →
 * primera estación activa de la sucursal.
 */
@Injectable()
export class KitchenTicketingService {
  constructor(private readonly prisma: PrismaService) {}

  async createForRound(
    tx: Prisma.TransactionClient,
    input: {
      organizationId: string | null;
      branchId: string | null;
      roundId: string;
      items: RoundItemRef[];
    },
  ) {
    if (!input.organizationId || input.items.length === 0) return [];

    const branch = input.branchId
      ? await tx.branch.findUnique({
          where: { id: input.branchId },
          select: { kitchenMode: true },
        })
      : null;

    if (branch?.kitchenMode !== KitchenMode.ADVANCED) return [];

    const itemIds = [...new Set(input.items.map((item) => item.itemId))];
    const [items, rules, stationRows] = await Promise.all([
      tx.item.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, categoryId: true, defaultStationId: true },
      }),
      tx.kitchenStationRule.findMany({
        where: {
          organizationId: input.organizationId,
          OR: [
            { branchId: input.branchId },
            ...(input.branchId ? [{ branchId: null }] : []),
          ],
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        select: {
          stationId: true,
          itemId: true,
          categoryId: true,
          menuId: true,
        },
      }),
      tx.kitchenStation.findMany({
        where: {
          organizationId: input.organizationId,
          branchId: input.branchId,
          isActive: true,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true },
      }),
    ]);

    let stations = stationRows;

    if (stations.length === 0) {
      const fallback = await tx.kitchenStation.create({
        data: {
          organizationId: input.organizationId,
          branchId: input.branchId,
          name: 'Cocina',
          code: 'COCINA',
          type: 'CUSTOM',
        },
        select: { id: true },
      });

      stations = [fallback];
    }

    const stationIds = new Set(stations.map((station) => station.id));
    const itemById = new Map(items.map((item) => [item.id, item]));
    const ruleByItem = new Map<string, string>();
    const ruleByCategory = new Map<string, string>();
    const ruleByMenu = new Map<string, string>();

    for (const rule of rules) {
      if (!stationIds.has(rule.stationId)) continue;
      if (rule.itemId && !ruleByItem.has(rule.itemId)) {
        ruleByItem.set(rule.itemId, rule.stationId);
      }
      if (rule.categoryId && !ruleByCategory.has(rule.categoryId)) {
        ruleByCategory.set(rule.categoryId, rule.stationId);
      }
      if (rule.menuId && !ruleByMenu.has(rule.menuId)) {
        ruleByMenu.set(rule.menuId, rule.stationId);
      }
    }

    const menuIds = [...ruleByMenu.keys()];
    const menuItems = menuIds.length
      ? await tx.menuItem.findMany({
          where: { itemId: { in: itemIds }, menuId: { in: menuIds } },
          select: { itemId: true, menuId: true },
        })
      : [];
    const ruleByMenuForItem = new Map<string, string>();

    for (const row of menuItems) {
      if (ruleByMenuForItem.has(row.itemId)) continue;
      const stationId = ruleByMenu.get(row.menuId);
      if (stationId) ruleByMenuForItem.set(row.itemId, stationId);
    }

    const fallbackStation = stations[0].id;
    const grouped = new Map<string, string[]>();

    for (const item of input.items) {
      const catalogItem = itemById.get(item.itemId);
      const stationId =
        (catalogItem?.defaultStationId &&
        stationIds.has(catalogItem.defaultStationId)
          ? catalogItem.defaultStationId
          : null) ??
        ruleByItem.get(item.itemId) ??
        (catalogItem?.categoryId
          ? ruleByCategory.get(catalogItem.categoryId)
          : undefined) ??
        ruleByMenuForItem.get(item.itemId) ??
        fallbackStation;

      const list = grouped.get(stationId) ?? [];
      list.push(item.id);
      grouped.set(stationId, list);
    }

    const tickets = [];

    for (const [stationId, orderItemIds] of grouped) {
      const ticket = await tx.kitchenTicket.create({
        data: {
          organizationId: input.organizationId,
          branchId: input.branchId,
          orderRoundId: input.roundId,
          stationId,
          status: KitchenTicketStatus.PENDING,
          items: {
            create: orderItemIds.map((orderItemId) => ({ orderItemId })),
          },
        },
      });

      await tx.orderItem.updateMany({
        where: { id: { in: orderItemIds } },
        data: { stationId },
      });

      tickets.push(ticket);
    }

    return tickets;
  }
}
