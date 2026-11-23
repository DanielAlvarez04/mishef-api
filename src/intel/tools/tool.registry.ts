import { Injectable, Logger } from '@nestjs/common';

import { rolesHavePermission } from '../../common/permissions';
import { redactPii } from '../pii';
import { CatalogTools } from './catalog.tools';
import { ForecastTools } from './forecast.tools';
import { InventoryTools } from './inventory.tools';
import { KitchenTools } from './kitchen.tools';
import { SalesTools } from './sales.tools';
import type {
  IntelTool,
  IntelToolContext,
  IntelToolResult,
} from './tool.types';
import type { IntelToolDefinition } from '../providers/openai-compatible.client';

@Injectable()
export class IntelToolRegistry {
  private readonly logger = new Logger(IntelToolRegistry.name);
  private readonly tools: IntelTool[];

  constructor(
    sales: SalesTools,
    catalog: CatalogTools,
    inventory: InventoryTools,
    kitchen: KitchenTools,
    forecast: ForecastTools,
  ) {
    this.tools = [
      ...sales.tools,
      ...catalog.tools,
      ...inventory.tools,
      ...kitchen.tools,
      ...forecast.tools,
    ];
  }

  names(): string[] {
    return this.tools.map((tool) => tool.name);
  }

  definitions(): IntelToolDefinition[] {
    return this.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async execute(
    name: string,
    rawArgs: unknown,
    ctx: IntelToolContext,
  ): Promise<IntelToolResult> {
    const tool = this.tools.find((candidate) => candidate.name === name);

    if (!tool) {
      return { ok: false, error: `Herramienta no encontrada: ${name}` };
    }

    if (!rolesHavePermission(ctx.roles, tool.permission)) {
      return {
        ok: false,
        error: 'No tienes permiso para consultar esta información.',
      };
    }

    const parsed = tool.schema.safeParse(rawArgs ?? {});

    if (!parsed.success) {
      return {
        ok: false,
        error: `Argumentos inválidos: ${parsed.error.issues
          .map((issue) => issue.message)
          .join(', ')}`,
      };
    }

    try {
      return await tool.execute(ctx, parsed.data as Record<string, unknown>);
    } catch (error) {
      this.logger.warn(
        `Tool ${name} falló: ${redactPii(
          error instanceof Error ? error.message : 'error desconocido',
        )}`,
      );

      return {
        ok: false,
        error: 'La consulta falló. Intenta de nuevo o revisa el periodo.',
      };
    }
  }
}
