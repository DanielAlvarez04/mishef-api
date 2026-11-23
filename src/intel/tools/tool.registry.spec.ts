import type { Role } from '@prisma/client';
import { z } from 'zod';

import { IntelToolRegistry } from './tool.registry';
import type { IntelTool, IntelToolContext } from './tool.types';

const context: IntelToolContext = {
  organizationId: 'org-a',
  branchId: null,
  userId: 'user-a',
  roles: ['ADMIN'] as Role[],
  currency: 'MXN',
  taxRate: 0.16,
};

function fakeTool(overrides: Partial<IntelTool> = {}): IntelTool {
  return {
    name: 'fake',
    description: 'Herramienta de prueba',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    schema: z.object({}).strict(),
    permission: 'reports:read',
    execute: jest.fn(async () => ({ ok: true, data: 'ok' })),
    ...overrides,
  };
}

function registryWith(tool: IntelTool): IntelToolRegistry {
  return new IntelToolRegistry(
    { tools: [tool] } as never,
    { tools: [] } as never,
    { tools: [] } as never,
    { tools: [] } as never,
    { tools: [] } as never,
  );
}

describe('IntelToolRegistry', () => {
  it('inyecta la organización de la sesión y no la de los argumentos', async () => {
    const execute = jest.fn(async (ctx: IntelToolContext) => ({
      ok: true,
      data: ctx.organizationId,
    }));
    const registry = registryWith(fakeTool({ execute }));
    const result = await registry.execute('fake', {}, context);

    expect(result).toEqual({ ok: true, data: 'org-a' });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a' }),
      {},
    );
  });

  it('rechaza argumentos que intentan mandar organizationId', async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const registry = registryWith(fakeTool({ execute }));
    const result = await registry.execute(
      'fake',
      { organizationId: 'org-b' },
      context,
    );

    expect(result.ok).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('niega una tool cuando el rol no tiene el permiso', async () => {
    const execute = jest.fn(async () => ({ ok: true }));
    const registry = registryWith(fakeTool({ execute }));
    const result = await registry.execute('fake', {}, {
      ...context,
      roles: ['INVENTORY_MANAGER'] as Role[],
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('permiso');
    expect(execute).not.toHaveBeenCalled();
  });

  it('devuelve un error claro si la tool no existe', async () => {
    const registry = registryWith(fakeTool());
    const result = await registry.execute('no-existe', {}, context);

    expect(result.ok).toBe(false);
    expect(result.error).toContain('no encontrada');
  });
});
