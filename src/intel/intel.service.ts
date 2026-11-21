import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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

const HISTORY_LIMIT = 20;
const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function buildSystemPrompt(organizationName: string, locale: string): string {
  return [
    `Eres el asistente de Mishef para el negocio "${organizationName}".`,
    `Responde en ${locale === 'en-US' ? 'inglés' : 'español de México'}.`,
    'Sé breve, claro y práctico. Prioriza acciones concretas.',
    'No inventes cifras ni datos. Si no tienes una herramienta para consultar el negocio, dilo explícitamente.',
    'No generes SQL. No reveles información de otras organizaciones.',
    'En esta fase solo respondes preguntas; no ejecutas acciones.',
  ].join(' ');
}

@Injectable()
export class IntelService {
  private readonly logger = new Logger(IntelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: OpenAiCompatibleClient,
  ) {}

  async getConfig(user: JwtUser) {
    const organization = await this.requireOrganization(user);
    const settings = readIntelSettings();
    const usage = await this.usageSummary(organization.id);

    return {
      enabled: organization.intelEnabled,
      configured: settings.configured,
      provider: settings.provider,
      model: settings.model,
      fastModel: settings.fastModel,
      visionModel: settings.visionModel,
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
   * Chat por SSE.
   *
   * El método escribe la respuesta directamente porque el stream no encaja en
   * el ciclo normal de Nest. Aun si el cliente se desconecta, guarda el
   * mensaje parcial y el consumo para que la auditoría no pierda el evento.
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

    if (!settings.configured || !settings.apiKey || !settings.model) {
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

    const history = await this.prisma.aiMessage.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
      take: HISTORY_LIMIT,
      select: { role: true, content: true },
    });

    const messages: IntelChatMessage[] = [
      {
        role: 'system',
        content: buildSystemPrompt(
          organization.name,
          dto.locale ?? conversation.locale,
        ),
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
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let errorMessage: string | null = null;

    try {
      for await (const event of this.client.streamChat({
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
        messages,
        signal: controller.signal,
      })) {
        if (event.type === 'delta') {
          fullText += event.text;
          this.writeEvent(res, 'delta', { text: event.text });
        } else {
          tokensIn = event.tokensIn ?? tokensIn;
          tokensOut = event.tokensOut ?? tokensOut;
        }
      }
    } catch (error) {
      errorMessage = controller.signal.aborted
        ? 'La respuesta se canceló'
        : 'No se pudo completar la respuesta';

      this.logger.warn(
        `Intel chat falló: ${redactPii(
          error instanceof Error ? error.message : 'error desconocido',
        )}`,
      );
      this.writeEvent(res, 'error', { message: errorMessage });
    } finally {
      clearInterval(heartbeat);
      req.off('close', onClose);
    }

    const latencyMs = Date.now() - startedAt;
    const estimatedIn =
      tokensIn ?? estimateTokens(messages.map((m) => m.content).join('\n'));
    const estimatedOut = tokensOut ?? estimateTokens(fullText);

    const assistantMessage = await this.prisma.aiMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'ASSISTANT',
        content: fullText,
        tokensIn: estimatedIn,
        tokensOut: estimatedOut,
        latencyMs,
        error: errorMessage,
      },
    });

    await this.prisma.aiConversation.update({
      where: { id: conversation.id },
      data: { updatedAt: new Date() },
    });

    await this.upsertUsage(
      organization.id,
      settings.model,
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
          model: settings.model,
          tokensIn: estimatedIn,
          tokensOut: estimatedOut,
          latencyMs,
          error: errorMessage,
        },
      },
    });

    this.writeEvent(res, 'done', {
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      tokensIn: estimatedIn,
      tokensOut: estimatedOut,
      latencyMs,
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
      select: { id: true, name: true, intelEnabled: true },
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
