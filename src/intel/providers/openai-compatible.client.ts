import { Injectable, Logger } from '@nestjs/common';
import { redactPii } from '../pii';

export type IntelChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type IntelStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; tokensIn?: number; tokensOut?: number };

/**
 * Cliente mínimo para cualquier proveedor OpenAI-compatible.
 *
 * No interpreta el contenido: solo traduce el stream SSE del proveedor a
 * eventos tipados. La validación de la respuesta y las reglas de negocio viven
 * en `IntelService`.
 */
@Injectable()
export class OpenAiCompatibleClient {
  private readonly logger = new Logger(OpenAiCompatibleClient.name);

  async *streamChat(params: {
    baseUrl: string;
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
