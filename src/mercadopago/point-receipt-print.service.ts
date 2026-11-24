import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';
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
 * Envía el ticket a una terminal Point Smart.
 *
 * El ticket es una acción `custom` con texto y etiquetas. El logo ya no se
 * imprime en el ticket; el logo del negocio se usa solo en la app.
 */
@Injectable()
export class PointReceiptPrintService {
  private readonly logger = new Logger(PointReceiptPrintService.name);

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
    const uniqueReference = `${input.reference.slice(0, 50)}-${randomUUID().slice(
      0,
      8,
    )}`;

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
        logo: null,
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
