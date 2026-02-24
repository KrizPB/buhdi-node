/**
 * OpenAI-Compatible LLM Provider
 * 
 * Works with: LM Studio, vLLM, text-generation-webui, LocalAI,
 * and any server exposing /v1/chat/completions.
 * Also works with mybuhdi.com cloud endpoint.
 */

import {
  LLMProviderConfig, ChatMessage, CompletionRequest, CompletionResponse,
  ToolCall, ProviderHealth, StreamCallback
} from '../types';

export class OpenAICompatProvider {
  private config: LLMProviderConfig;
  private health: ProviderHealth;

  /** Build auth headers based on provider config */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!this.config.apiKey) return headers;

    const authType = this.config.authType || 'bearer';
    switch (authType) {
      case 'bearer':
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        break;
      case 'x-api-key':
        headers['X-API-Key'] = this.config.apiKey;
        break;
      case 'api-key':
        headers['api-key'] = this.config.apiKey; // Azure style
        break;
      case 'custom':
        if (this.config.customHeader && /^[A-Za-z0-9-]+$/.test(this.config.customHeader)) {
          headers[this.config.customHeader] = this.config.apiKey;
        }
        break;
      default:
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }
    return headers;
  }

  constructor(config: LLMProviderConfig) {
    this.config = config;
    this.health = {
      name: config.name,
      endpoint: config.endpoint,
      model: config.model,
      available: false,
      lastCheck: 0,
      lastLatencyMs: 0,
    };
  }

  getHealth(): ProviderHealth { return this.health; }

  async healthCheck(): Promise<boolean> {
    const start = Date.now();
    try {
      const headers: Record<string, string> = { ...this.authHeaders() };

      const res = await fetch(`${this.config.endpoint}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });

      if (!res.ok) {
        this.health.available = false;
        this.health.error = `HTTP ${res.status}`;
        return false;
      }

      const data = await res.json() as any;
      const models = (data.data || []).map((m: any) => m.id);
      this.health.models = models;
      this.health.available = true;
      this.health.lastCheck = Date.now();
      this.health.lastLatencyMs = Date.now() - start;
      this.health.error = undefined;
      return true;
    } catch (err: any) {
      this.health.available = false;
      this.health.lastCheck = Date.now();
      this.health.lastLatencyMs = Date.now() - start;
      this.health.error = err.message;
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.authHeaders() };

    const body: any = {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 2048,
      stream: false,
    };

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    try {
      const res = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${this.config.name} ${res.status}: ${errText.substring(0, 200)}`);
      }

      const data = await res.json() as any;
      const choice = data.choices?.[0];
      const latency = Date.now() - start;
      this.health.lastLatencyMs = latency;

      const toolCalls: ToolCall[] = (choice?.message?.tool_calls || []).map((tc: any) => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        type: 'function',
        function: {
          name: tc.function?.name || '',
          arguments: tc.function?.arguments || '{}',
        },
      }));

      return {
        content: choice?.message?.content || null,
        toolCalls,
        finishReason: choice?.finish_reason === 'tool_calls' ? 'tool_calls'
          : toolCalls.length > 0 ? 'tool_calls'
          : choice?.finish_reason === 'length' ? 'length'
          : 'stop',
        provider: this.config.name,
        model: this.config.model,
        latencyMs: latency,
        tokensUsed: data.usage ? {
          prompt: data.usage.prompt_tokens || 0,
          completion: data.usage.completion_tokens || 0,
        } : undefined,
      };
    } catch (err: any) {
      return {
        content: null,
        toolCalls: [],
        finishReason: 'error',
        provider: this.config.name,
        model: this.config.model,
        latencyMs: Date.now() - start,
      };
    }
  }

  async stream(request: CompletionRequest, callbacks: StreamCallback): Promise<void> {
    const start = Date.now();
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...this.authHeaders() };

    const body: any = {
      model: this.config.model,
      messages: request.messages,
      temperature: request.temperature ?? 0.7,
      max_tokens: request.maxTokens ?? 2048,
      stream: true,
    };

    if (request.tools?.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }

    try {
      const res = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) throw new Error(`${this.config.name} ${res.status}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      // Track partial tool calls being built across SSE chunks
      const partialToolCalls = new Map<number, { id: string; name: string; args: string }>();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (payload === '[DONE]') continue;

          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              fullContent += delta.content;
              callbacks.onToken(delta.content);
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!partialToolCalls.has(idx)) {
                  partialToolCalls.set(idx, {
                    id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                    name: tc.function?.name || '',
                    args: '',
                  });
                }
                const partial = partialToolCalls.get(idx)!;
                if (tc.function?.name) partial.name = tc.function.name;
                if (tc.function?.arguments) partial.args += tc.function.arguments;
              }
            }
          } catch (e) {
            // M7-FIX: Log stream parse errors
            console.warn(`[${this.config.name}] Stream parse error:`, (e as Error).message);
          }
        }
      }

      // Finalize tool calls
      for (const partial of partialToolCalls.values()) {
        const toolCall: ToolCall = {
          id: partial.id,
          type: 'function',
          function: { name: partial.name, arguments: partial.args || '{}' },
        };
        toolCalls.push(toolCall);
        callbacks.onToolCall?.(toolCall);
      }

      callbacks.onDone({
        content: fullContent || null,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        provider: this.config.name,
        model: this.config.model,
        latencyMs: Date.now() - start,
      });
    } catch (err: any) {
      callbacks.onError(err);
    }
  }
}

