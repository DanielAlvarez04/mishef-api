import { Injectable, Logger } from '@nestjs/common';
import { redactPii } from '../pii';

export interface IntelToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface IntelToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export type IntelChatMessage =
  | { role: 'system' | 'user'; content: string }
  | {
      role: 'assistant';
      content?: string | null;
      tool_calls?: IntelToolCall[];
    }
  | {
      role: 'tool';
      content: string;
      tool_call_id: string;
      name?: string;
    };

export type IntelStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; tokensIn?: number; tokensOut?: number };

export interface IntelCompletion {
  content: string | null;
  toolCalls: IntelToolCall[];
  tokensIn?: number;
  tokensOut?: number;
  finishReason?: string;
}

/**
 * Cliente mínimo para cualquier proveedor OpenAI-compatible.
 *
 * `completeChat` se usa para el ciclo de herramientas (no streaming).
 * `streamChat` se usa para la respuesta final al usuario.
 */
@Injectable()
export class OpenAiCompatibleClient {
  private readonly logger = new Logger(OpenAiCompatibleClient.name);

  async completeChat(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: IntelChatMessage[];
    tools?: IntelToolDefinition[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<IntelCompletion> {
    const response = await fetch(`${params.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: false,
        temperature: params.temperature ?? 0.2,
        max_tokens: params.maxTokens ?? 900,
        ...(params.tools?.length
          ? { tools: params.tools, tool_choice: 'auto' }
          : {}),
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Proveedor IA respondió ${response.status}: ${redactPii(body).slice(0, 300)}`,
      );
      throw new Error(`El proveedor de IA respondió ${response.status}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: IntelToolCall[];
        };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    const choice = json.choices?.[0];
    const message = choice?.message ?? {};

    return {
      content: typeof message.content === 'string' ? message.content : null,
      toolCalls: Array.isArray(message.tool_calls)
        ? message.tool_calls.filter(
            (call) =>
              typeof call?.id === 'string' &&
              typeof call?.function?.name === 'string' &&
              typeof call?.function?.arguments === 'string',
          )
        : [],
      tokensIn: json.usage?.prompt_tokens,
      tokensOut: json.usage?.completion_tokens,
      finishReason: choice?.finish_reason,
    };
  }

  async completeVision(params: {
    baseUrl: string;
    apiKey: string;
    model: string;
    prompt: string;
    imageDataUri: string;
    maxTokens?: number;
    signal?: AbortSignal;
  }): Promise<IntelCompletion> {
    const response = await fetch(`${params.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: params.prompt },
              { type: 'image_url', image_url: { url: params.imageDataUri } },
            ],
          },
        ],
        stream: false,
        temperature: 0,
        max_tokens: params.maxTokens ?? 1500,
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Proveedor de visión respondió ${response.status}: ${redactPii(body).slice(0, 300)}`,
      );
      throw new Error(`El proveedor de visión respondió ${response.status}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string;
      }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
      };
    };

    const choice = json.choices?.[0];

    return {
      content:
        typeof choice?.message?.content === 'string'
          ? choice.message.content
          : null,
      toolCalls: [],
      tokensIn: json.usage?.prompt_tokens,
      tokensOut: json.usage?.completion_tokens,
      finishReason: choice?.finish_reason,
    };
  }

  async *streamChat(params: {    baseUrl: string;
    apiKey: string;
    model: string;
    messages: IntelChatMessage[];
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<IntelStreamEvent> {
    const response = await fetch(`${params.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${params.apiKey}`,
      },
      body: JSON.stringify({
        model: params.model,
        messages: params.messages,
        stream: true,
        temperature: params.temperature ?? 0.3,
        max_tokens: params.maxTokens ?? 900,
      }),
      signal: params.signal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      this.logger.error(
        `Proveedor IA respondió ${response.status}: ${redactPii(body).slice(0, 300)}`,
      );
      throw new Error(`El proveedor de IA respondió ${response.status}`);
    }

    if (!response.body) {
      throw new Error('El proveedor de IA no devolvió un stream');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const data = trimmed.slice(5).trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
              };
            };

            const text = parsed.choices?.[0]?.delta?.content;
            if (typeof text === 'string' && text.length > 0) {
              yield { type: 'delta', text };
            }

            if (parsed.usage) {
              tokensIn = parsed.usage.prompt_tokens ?? tokensIn;
              tokensOut = parsed.usage.completion_tokens ?? tokensOut;
            }
          } catch {
            // Algunos proveedores mandan keep-alives o líneas que no son JSON.
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'usage', tokensIn, tokensOut };
  }
}
