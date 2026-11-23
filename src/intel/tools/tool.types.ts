import type { Role } from '@prisma/client';
import type { z } from 'zod';

import type { Permission } from '../../common/permissions';

export interface IntelToolContext {
  organizationId: string;
  branchId: string | null;
  userId: string;
  roles: Role[];
  currency: string;
  taxRate: number;
}

export interface IntelToolPeriod {
  from: string;
  to: string;
  label: string;
}

export interface IntelToolResult {
  ok: boolean;
  data?: unknown;
  summary?: string;
  error?: string;
  period?: IntelToolPeriod;
  source?: string;
}

export interface IntelTool {
  name: string;
  description: string;
  /** JSON Schema que ve el modelo. */
  parameters: Record<string, unknown>;
  /** Validación real de los argumentos. Debe ser `.strict()`. */
  schema: z.ZodTypeAny;
  permission: Permission;
  execute: (
    ctx: IntelToolContext,
    args: Record<string, unknown>,
  ) => Promise<IntelToolResult>;
}
