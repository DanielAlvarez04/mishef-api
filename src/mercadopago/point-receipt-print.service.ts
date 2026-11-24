import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
import { getR2Object } from '../uploads/r2';
import { MercadoPagoClient } from './mercadopago.client';
import { MercadoPagoTokenService } from './mercadopago-token.service';
import {
  renderReceiptText,
  type PointReceiptInput,
  type ReceiptTemplate,
} from './point-receipt';
import { supportsPointPrinting } from './point-terminal';

export interface PointReceiptPrintInput {
  organizationId: string;
  branchId: string | null;
  template: ReceiptTemplate;
  receipt: PointReceiptInput;
  /** Terminales usadas por los pagos Point; se prioriza la primera activa. */
  terminalIds?: Array<string | null>;
  /** Evita una consulta extra cuando el llamador ya cargó la organización. */
  logoReceiptKey?: string | null;
  /** Referencia externa de las acciones (máx. 64 caracteres). */
  reference: string;
}

export interface PointReceiptPrintResult {
  terminalId: string;
  logo: { printed: boolean; error?: string } | null;
  ticket: { actionId: string; status: string };
  warnings: string[];
}

/**
 * Envía el ticket (y opcionalmente el logo) a una terminal Point Smart.
 *
 * El logo se manda como una acción `image` y el ticket como `custom`. Son dos
 * trabajos de impresión; el switch de la plantilla decide si se manda el logo.
 */
@Injectable()
export class PointReceiptPrintService {
  private readonly logger = new Logger(PointReceiptPrintService.name);
  private readonly logoCache = new Map<string, string>();
  private readonly maxLogoCacheEntries = 200;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: MercadoPagoClient,
    private readonly tokens: MercadoPagoTokenService,
  ) {}

  async print(input: PointReceiptPrintInput): Promise<PointReceiptPrintResult> {
    const terminal = await this.resolveTerminal(
      input.organizationId,
      input.branchId,
      input.terminalIds ?? [],
    );

    if (supportsPointPrinting(terminal.model) === false) {
      throw new BadRequestException(
        'Point Air 2 no tiene impresora. Usa una terminal Point Smart 1 o 2.',
      );
    }

    const accessToken = await this.tokens.getAccessToken(input.organizationId);
    const warnings: string[] = [];
    let logo: { printed: boolean; error?: string } | null = null;
    const uniqueReference = `${input.reference.slice(0, 50)}-${randomUUID().slice(
      0,
      8,
    )}`;

    if (input.template.printLogo) {
      const logoKey =
        input.logoReceiptKey === undefined
          ? await this.logoKey(input.organizationId)
          : input.logoReceiptKey;

      if (logoKey) {
        try {
          const base64 = await this.logoBase64(logoKey);

          if (!base64) {
            logo = { printed: false, error: 'El logo no está en R2.' };
          } else if (base64.length > 1_000_000) {
            logo = {
              printed: false,
              error: 'El JPEG del logo supera 1 MB.',
            };
          } else {
            await this.client.createPrintAction(
              accessToken,
              {
                type: 'print',
                external_reference: this.reference(
                  `logo-${uniqueReference}`,
                ),
                config: {
                  point: {
                    terminal_id: terminal.terminalId,
                    subtype: 'image',
                  },
                },
                content: base64,
              },
              randomUUID(),
            );

            logo = { printed: true };
          }
        } catch (error) {
          logo = { printed: false, error: (error as Error).message };
          this.logger.warn(
            `No se pudo imprimir el logo (org=${input.organizationId}, terminal=${
              terminal.terminalId
            }): ${(error as Error).message}`,
          );
        }
      } else {
        logo = { printed: false, error: 'El negocio no tiene logo de recibo.' };
      }
    }

    if (logo?.error) warnings.push(`Logo: ${logo.error}`);

    const rendered = renderReceiptText(input.template, input.receipt);
    warnings.push(...rendered.warnings);

    try {
      const action = await this.client.createPrintAction(
        accessToken,
        {
          type: 'print',
          external_reference: this.reference(uniqueReference),
          config: {
            point: {
              terminal_id: terminal.terminalId,
              subtype: 'custom',
            },
          },
          content: rendered.content,
        },
        randomUUID(),
      );

      return {
        terminalId: terminal.terminalId,
        logo,
        ticket: { actionId: action.id, status: action.status },
        warnings,
      };
    } catch (error) {
      this.logger.warn(
        `No se pudo imprimir el ticket (org=${input.organizationId}, terminal=${
          terminal.terminalId
        }): ${(error as Error).message}`,
      );

      throw new BadGatewayException(
        `No se pudo imprimir en la terminal: ${
          (error as Error).message
        }. Verifica que sea Point Smart 1/2 y que la impresión personalizada esté habilitada.`,
      );
    }
  }

  private async logoKey(organizationId: string): Promise<string | null> {
    const organization = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { logoReceiptKey: true },
    });

    return organization?.logoReceiptKey ?? null;
  }

  private async logoBase64(key: string): Promise<string | null> {
    const cached = this.logoCache.get(key);
    if (cached) return cached;

    const buffer = await getR2Object(key);
    if (!buffer) return null;

    const base64 = buffer.toString('base64');
    this.logoCache.set(key, base64);

    if (this.logoCache.size > this.maxLogoCacheEntries) {
      const oldest = this.logoCache.keys().next().value;
      if (oldest) this.logoCache.delete(oldest);
    }

    return base64;
  }

  private reference(value: string): string {
    return value
      .replace(/[^A-Za-z0-9_-]/g, '-')
      .slice(0, 64);
  }

  private async resolveTerminal(
    organizationId: string,
    branchId: string | null,
    terminalIds: Array<string | null>,
  ) {
    const fromPayment = terminalIds.find(
      (terminalId): terminalId is string => Boolean(terminalId),
    );

    if (fromPayment) {
      const terminal = await this.prisma.mercadoPagoTerminal.findFirst({
        where: {
          organizationId,
          terminalId: fromPayment,
          isActive: true,
        },
      });

      if (terminal) return terminal;
    }

    if (branchId) {
      const branchTerminal = await this.prisma.mercadoPagoTerminal.findFirst({
        where: {
          organizationId,
          branchId,
          isActive: true,
          operatingMode: 'PDV',
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
      });

      if (branchTerminal) return branchTerminal;
    }

    const terminal = await this.prisma.mercadoPagoTerminal.findFirst({
      where: {
        organizationId,
        isActive: true,
        operatingMode: 'PDV',
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });

    if (terminal) return terminal;

    throw new BadRequestException(
      'No hay una terminal Point en modo PDV para imprimir. Configúrala en Ajustes → Pagos.',
    );
  }
}
