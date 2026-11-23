import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';
import { JwtUser } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { IntelChatDto, IntelFeedbackDto } from './dto/intel.dto';
import { readIntelSettings } from './intel.config';
import {
  IntelChatMessage,
  OpenAiCompatibleClient,
} from './providers/openai-compatible.client';
import { redactPii } from './pii';
import { IntelToolRegistry } from './tools/tool.registry';
import type { IntelToolContext } from './tools/tool.types';

const HISTORY_LIMIT = 20;
const MAX_TOOL_ROUNDS = 4;
const CHARS_PER_TOKEN = 4;

interface ToolTraceEntry {
  name: string;
  ok: boolean;
  summary?: string;
  error?: string;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function chunkText(text: string, size = 80): string[] {
  const chunks: string[] = [];

  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }

  return chunks;
}

function buildSystemPrompt(input: {
  organizationName: string;
  currency: string;
  taxRate: number;
  branchName: string | null;
  branchCount: number;
  locale: string;
}): string {
  const date = new Intl.DateTimeFormat('es-MX', {
    dateStyle: 'long',
  }).format(new Date());

  const scope = input.branchName
    ? `Sucursal activa: ${input.branchName}.`
    : input.branchCount > 1
      ? `Vista consolidada de ${input.branchCount} sucursales.`
      : 'Vista de la única sucursal.';

  return [
    `Eres el asistente de Mishef para el negocio "${input.organizationName}".`,
    `Fecha actual: ${date}. Moneda: ${input.currency}. IVA: ${Math.round(input.taxRate * 100)}%. ${scope}`,
    `Responde en ${input.locale === 'en-US' ? 'inglés' : 'español de México'}.`,
    'Usa las herramientas para cualquier cifra de ventas, márgenes, pagos o inventario. No inventes datos.',
    'Cita el periodo y la fuente cuando des una cifra.',
    'Si una herramienta falla o no tienes permiso, dilo; no supongas el resultado.',
    'Si no tienes una herramienta para lo que pide el usuario, dilo explícitamente.',
    'No generes SQL. No reveles información de otras organizaciones.',
    'En esta fase solo consultas y explicas; no ejecutas acciones.',
  ].join(' ');
}

@Injectable()
export class IntelService {
  private readonly logger = new Logger(IntelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: OpenAiCompatibleClient,
    private readonly tools: IntelToolRegistry,
  ) {}

  async getConfig(user: JwtUser) {
    const organization = await this.requireOrganization(user);
    const settings = readIntelSettings();
    const usage = await this.usageSummary(organization.id);

    return {
      enabled: organization.intelEnabled,
      configured: settings.configured,
      models: settings.targets.map((target) => ({
        provider: target.provider,
        model: target.model,
      })),
      tools: this.tools.names(),
      monthlyTokenLimit: settings.monthlyTokenLimit,
      usage,
    };
  }

  async setEnabled(user: JwtUser, enabled: boolean) {
    const organization = await this.requireOrganization(user);

    const updated = await this.prisma.organization.update({
      where: { id: organization.id },
      data: { intelEnabled: enabled },
      select: { intelEnabled: true },
    });

    await this.prisma.auditLog.create({
      data: {
        organizationId: organization.id,
        userId: user.sub,
        action: enabled ? 'INTEL_ENABLED' : 'INTEL_DISABLED',
        entity: 'Organization',
        entityId: organization.id,
        newValues: { intelEnabled: enabled },
      },
    });

    return updated;
  }

  async listConversations(user: JwtUser) {
    const organization = await this.requireOrganization(user);

    return this.prisma.aiConversation.findMany({
      where: { organizationId: organization.id },
      orderBy: { updatedAt: 'desc' },
      take: 50,
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });
  }

  async getConversation(user: JwtUser, id: string) {
    const organization = await this.requireOrganization(user);

    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id, organizationId: organization.id },
      include: {
        messages: {
          orderBy: { createdAt: 'asc' },
          take: 100,
        },
      },
    });

    if (!conversation) {
      throw new NotFoundException('Conversación no encontrada');
    }

    return conversation;
  }

  async deleteConversation(user: JwtUser, id: string) {
    const organization = await this.requireOrganization(user);

    const result = await this.prisma.aiConversation.deleteMany({
      where: { id, organizationId: organization.id },
    });

    if (result.count === 0) {
      throw new NotFoundException('Conversación no encontrada');
    }

    return { deleted: true };
  }

  async getUsage(user: JwtUser) {
    const organization = await this.requireOrganization(user);
    const month = this.startOfMonth();

    const rows = await this.prisma.aiUsage.groupBy({
      by: ['feature', 'model'],
      where: { organizationId: organization.id, day: { gte: month } },
      _sum: { requests: true, tokensIn: true, tokensOut: true },
    });

    const summary = await this.usageSummary(organization.id);

    return {
      ...summary,
      byFeature: rows.map((row) => ({
        feature: row.feature,
        model: row.model,
        requests: row._sum.requests ?? 0,
        tokensIn: row._sum.tokensIn ?? 0,
        tokensOut: row._sum.tokensOut ?? 0,
      })),
    };
  }

  async feedback(user: JwtUser, dto: IntelFeedbackDto) {
    const organization = await this.requireOrganization(user);

    const message = await this.prisma.aiMessage.findFirst({
      where: {
        id: dto.messageId,
        conversation: { organizationId: organization.id },
      },
      select: { id: true },
    });

    if (!message) {
      throw new NotFoundException('Mensaje no encontrado');
    }

    await this.prisma.aiFeedback.create({
      data: {
        messageId: message.id,
        userId: user.sub,
        rating: dto.rating,
        comment: dto.comment?.trim() || null,
      },
    });

    return { ok: true };
  }

  /**
   * Chat por SSE con ciclo de herramientas.
   *
   * El modelo primero decide qué tools consultar (llamadas no streaming).
   * Después de obtener los datos, la respuesta final se envía por SSE en
   * fragmentos para que la UI la muestre de forma progresiva.
   */
  async chat(
    user: JwtUser,
    dto: IntelChatDto,
    res: Response,
    req: Request,
  ): Promise<void> {
    const organization = await this.requireOrganization(user);

    if (!organization.intelEnabled) {
      throw new ForbiddenException(
        'Intel no está activado para este negocio',
      );
    }

    const settings = readIntelSettings();

    if (!settings.configured || settings.targets.length === 0) {
      throw new ServiceUnavailableException(
        'Intel no está configurado en el servidor',
      );
    }

    const usage = await this.usageSummary(organization.id);

    if (usage.tokens >= settings.monthlyTokenLimit) {
      throw new HttpException('Cuota de IA agotada', 429);
    }

    const existing = dto.conversationId
      ? await this.prisma.aiConversation.findFirst({
          where: {
            id: dto.conversationId,
            organizationId: organization.id,
          },
        })
      : null;

    if (dto.conversationId && !existing) {
      throw new NotFoundException('Conversación no encontrada');
    }

    const conversation =
      existing ??
      (await this.prisma.aiConversation.create({
        data: {
          organizationId: organization.id,
          userId: user.sub,
          branchId: user.branchId ?? null,
          title: dto.message.slice(0, 80),
          locale: dto.locale ?? 'es-MX',
        },
      }));

    const branch = user.branchId
      ? await this.prisma.branch.findFirst({
          where: {
            id: user.branchId,
            organizationId: organization.id,
          },
          select: { name: true },
        })
      : null;

    const history = await this.prisma.aiMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });

    const messages: IntelChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt({
          organizationName: organization.name,
          currency: organization.currency,
          taxRate: Number(organization.taxRate),
          branchName: branch?.name ?? null,
          branchCount: organization._count.branches,
          locale: dto.locale ?? conversation.locale,
        }),
      },
      ...history.reverse().map((message) => ({
        role:
          message.role === 'ASSISTANT'
            ? ('assistant' as const)
            : message.role === 'USER'
              ? ('user' as const)
              : ('system' as const),
        content: message.content,
      })),
      { role: 'user', content: dto.message },
    ];

    await this.prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'USER',
        content: dto.message,
      },
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Evita que `compression` bufferice el stream; el SSE debe salir chunk a chunk.
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    this.writeEvent(res, 'start', { conversationId: conversation.id });

    const heartbeat = setInterval(() => {
      this.writeRaw(res, ': ping\n\n');
    }, 15_000);

    const controller = new AbortController();
    const onClose = () => controller.abort();
    req.on('close', onClose);

    const startedAt = Date.now();
    let fullText = '';
    let tokensIn = 0;
    let tokensOut = 0;
    let errorMessage: string | null = null;
    let usedModel: string | null = null;
    let usedProvider: string | null = null;
    const toolTrace: ToolTraceEntry[] = [];

    const context: IntelToolContext = {
      organizationId: organization.id,
      branchId: user.branchId ?? null,
      userId: user.sub,
      roles: user.roles,
      currency: organization.currency,
      taxRate: Number(organization.taxRate),
    };

    const definitions = this.tools.definitions();

    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        let completion: Awaited<
          ReturnType<OpenAiCompatibleClient['completeChat']>
        > | null = null;

        for (const target of settings.targets) {
          try {
            completion = await this.client.completeChat({
              baseUrl: target.baseUrl,
              apiKey: target.apiKey,
              model: target.model,
              messages,
              tools: definitions,
              signal: controller.signal,
            });
            usedModel = target.model;
            usedProvider = target.provider;
            break;
          } catch (error) {
            this.logger.warn(
              `Intel: falló ${target.provider}/${target.model}: ${redactPii(
                error instanceof Error ? error.message : 'error desconocido',
              )}`,
            );
          }
        }

        if (!completion) {
          errorMessage = controller.signal.aborted
            ? 'La respuesta se canceló'
            : 'No se pudo completar la respuesta';
          break;
        }

        tokensIn += completion.tokensIn ?? 0;
        tokensOut += completion.tokensOut ?? 0;

        if (completion.toolCalls.length === 0) {
          fullText = completion.content?.trim() ?? '';
          break;
        }

        messages.push({
          role: 'assistant',
          content: completion.content ?? null,
          tool_calls: completion.toolCalls,
        });

        for (const call of completion.toolCalls) {
          let args: unknown = {};

          try {
            args = call.function.arguments
              ? JSON.parse(call.function.arguments)
              : {};
          } catch {
            args = {};
          }

          this.writeEvent(res, 'tool', {
            name: call.function.name,
            status: 'running',
          });

          const result = await this.tools.execute(
            call.function.name,
            args,
            context,
          );

          toolTrace.push({
            name: call.function.name,
            ok: result.ok,
            summary: result.summary,
            error: result.error,
          });

          this.writeEvent(res, 'tool', {
            name: call.function.name,
            status: result.ok ? 'done' : 'error',
            summary: result.summary,
            error: result.error,
          });

          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(result),
          });
        }
      }

      if (!fullText && toolTrace.length > 0 && !errorMessage) {
        messages.push({
          role: 'system',
          content:
            'Responde al usuario usando los datos de las herramientas. No inventes. Si falta un dato, dilo.',
        });

        for (const target of settings.targets) {
          try {
            const completion = await this.client.completeChat({
              baseUrl: target.baseUrl,
              apiKey: target.apiKey,
              model: target.model,
              messages,
              signal: controller.signal,
            });

            tokensIn += completion.tokensIn ?? 0;
            tokensOut += completion.tokensOut ?? 0;
            fullText = completion.content?.trim() ?? '';
            usedModel = target.model;
            usedProvider = target.provider;

            if (fullText) break;
          } catch (error) {
            this.logger.warn(
              `Intel: respuesta final falló: ${redactPii(
                error instanceof Error ? error.message : 'error desconocido',
              )}`,
            );
          }
        }
      }

      if (!fullText && !errorMessage) {
        fullText =
          'No pude obtener una respuesta con las herramientas disponibles. Intenta reformular la pregunta o revisa el periodo.';
      }

      if (errorMessage) {
        this.writeEvent(res, 'error', { message: errorMessage });
      } else {
        for (const chunk of chunkText(fullText)) {
          if (controller.signal.aborted) break;
          this.writeEvent(res, 'delta', { text: chunk });
          await new Promise((resolve) => setTimeout(resolve, 8));
        }
      }
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
    }

    const latencyMs = Date.now() - startedAt;
    const hasOutput = fullText.length > 0;
    const estimatedIn = hasOutput
      ? (tokensIn ||
        estimateTokens(
          messages
            .map((message) =>
              typeof message.content === 'string' ? message.content : '',
            )
            .join('\n'),
        ))
      : 0;
    const estimatedOut = hasOutput
      ? (tokensOut || estimateTokens(fullText))
      : 0;
    const modelForUsage =
      usedModel ?? settings.targets[0]?.model ?? 'unknown';

    const assistantMessage = await this.prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'ASSISTANT',
        content: fullText,
        tokensIn: estimatedIn,
        tokensOut: estimatedOut,
        latencyMs,
        error: errorMessage,
        toolName: toolTrace.length > 0 ? 'tool_calls' : null,
        toolPayload:
          toolTrace.length > 0
            ? (JSON.parse(
                JSON.stringify({ calls: toolTrace }),
              ) as Prisma.InputJsonValue)
            : undefined,
      },
    });

    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    await this.upsertUsage(
      organization.id,
      modelForUsage,
      estimatedIn,
      estimatedOut,
    );

    await this.prisma.auditLog.create({
      data: {
        organizationId: organization.id,
        userId: user.sub,
        action: 'INTEL_CHAT',
        entity: 'AiConversation',
        entityId: conversation.id,
        newValues: {
          provider: usedProvider,
          model: modelForUsage,
          tokensIn: estimatedIn,
          tokensOut: estimatedOut,
          latencyMs,
          tools: toolTrace.map((tool) => tool.name),
          error: errorMessage,
        },
      },
    });

    this.writeEvent(res, 'done', {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      provider: usedProvider,
      model: usedModel,
      tokensIn: estimatedIn,
      tokensOut: estimatedOut,
      latencyMs,
      tools: toolTrace,
      error: errorMessage,
    });

    if (!res.writableEnded) {
      res.end();
    }
  }

  private async requireOrganization(user: JwtUser) {
    if (!user.organizationId) {
      throw new BadRequestException('La sesión no tiene organización');
    }

    const organization = await this.prisma.organization.findUnique({
      where: { id: user.organizationId },
      select: {
        id: true,
        name: true,
        intelEnabled: true,
        currency: true,
        taxRate: true,
        _count: { select: { branches: true } },
      },
    });

    if (!organization) {
      throw new NotFoundException('Organización no encontrada');
    }

    return organization;
  }

  private startOfMonth(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  private async usageSummary(organizationId: string) {
    const month = this.startOfMonth();
    const aggregate = await this.prisma.aiUsage.aggregate({
      where: { organizationId, day: { gte: month } },
      _sum: { requests: true, tokensIn: true, tokensOut: true },
    });

    const tokensIn = aggregate._sum.tokensIn ?? 0;
    const tokensOut = aggregate._sum.tokensOut ?? 0;

    return {
      month: month.toISOString().slice(0, 7),
      requests: aggregate._sum.requests ?? 0,
      tokensIn,
      tokensOut,
      tokens: tokensIn + tokensOut,
    };
  }

  private async upsertUsage(
    organizationId: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
  ) {
    const now = new Date();
    const day = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    await this.prisma.aiUsage.upsert({
      where: {
        organizationId_day_feature_model: {
          organizationId,
          day,
          feature: 'CHAT',
          model,
        },
      },
      create: {
        organizationId,
        day,
        feature: 'CHAT',
        model,
        requests: 1,
        tokensIn,
        tokensOut,
      },
      update: {
        requests: { increment: 1 },
        tokensIn: { increment: tokensIn },
        tokensOut: { increment: tokensOut },
      },
    });
  }

  private writeEvent(res: Response, event: string, data: unknown) {
    this.writeRaw(res, `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private writeRaw(res: Response, chunk: string) {
    if (res.writableEnded || res.destroyed) return;

    try {
      res.write(chunk);
    } catch {
      // El cliente se desconectó entre la comprobación y el write.
    }
  }
}
