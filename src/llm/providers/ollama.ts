/**
 * Ollama LLM Provider
 * 
 * Communicates with Ollama's REST API (default: localhost:11434).
 * Supports chat completions with tool calling (Ollama 0.4+).
 */

import {
  LLMProviderConfig, ChatMessage, CompletionRequest, CompletionResponse,
  ToolCall, ProviderHealth, StreamCallback
} from '../types';

export class OllamaProvider {
  private config: LLMProviderConfig;
  private health: ProviderHealth;

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

  /** Check if Ollama is running and the model is available */
  async healthCheck(): Promise<boolean> {
    const start = Date.now();
    try {
      const res = await fetch(`${this.config.endpoint}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        this.health.available = false;
        this.health.error = `HTTP ${res.status}`;
        return false;
      }
      const data = await res.json() as any;
      const models = (data.models || []).map((m: any) => m.name);
      this.health.models = models;
      
      // Check if our target model is available
      const modelAvailable = models.some((m: string) =>
        m === this.config.model || m.startsWith(this.config.model + ':')
      );
      
      this.health.available = modelAvailable;
      this.health.lastCheck = Date.now();
      this.health.lastLatencyMs = Date.now() - start;
      this.health.error = modelAvailable ? undefined : `Model "${this.config.model}" not found. Available: ${models.join(', ')}`;
      return modelAvailable;
    } catch (err: any) {
      this.health.available = false;
      this.health.lastCheck = Date.now();
      this.health.lastLatencyMs = Date.now() - start;
      this.health.error = err.message;
      return false;
    }
  }

  /** Send a chat completion request */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const start = Date.now();

    // Build Ollama chat request
    const body: any = {
      model: this.config.model,
      messages: request.messages.map(m => this.toOllamaMessage(m)),
      stream: false,
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens ?? 2048,
      },
    };

    // Add tools if provided (Ollama 0.4+ format)
    if (request.tools?.length) {
      body.tools = request.tools;
    }

    try {
      const res = await fetch(`${this.config.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000), // 2 min timeout for local models
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Ollama ${res.status}: ${errText.substring(0, 200)}`);
      }

      const data = await res.json() as any;
      const latency = Date.now() - start;
      this.health.lastLatencyMs = latency;

      // Parse tool calls from response
      const toolCalls: ToolCall[] = [];
      if (data.message?.tool_calls?.length) {
        for (const tc of data.message.tool_calls) {
          toolCalls.push({
            id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: 'function',
            function: {
              name: tc.function?.name || '',
              arguments: typeof tc.function?.arguments === 'string'
                ? tc.function.arguments
                : JSON.stringify(tc.function?.arguments || {}),
            },
          });
        }
      }

      return {
        content: data.message?.content || null,
        toolCalls,
        finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
        provider: this.config.name,
        model: this.config.model,
        latencyMs: latency,
        tokensUsed: data.eval_count ? {
          prompt: data.prompt_eval_count || 0,
          completion: data.eval_count || 0,
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

  /** Stream a chat completion */
  async stream(request: CompletionRequest, callbacks: StreamCallback): Promise<void> {
    const start = Date.now();

    const body: any = {
      model: this.config.model,
      messages: request.messages.map(m => this.toOllamaMessage(m)),
      stream: true,
      options: {
        temperature: request.temperature ?? 0.7,
        num_predict: request.maxTokens ?? 2048,
      },
    };

    if (request.tools?.length) {
      body.tools = request.tools;
    }

    try {
      const res = await fetch(`${this.config.endpoint}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        throw new Error(`Ollama ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            if (chunk.message?.content) {
              fullContent += chunk.message.content;
              callbacks.onToken(chunk.message.content);
            }
            if (chunk.message?.tool_calls?.length) {
              for (const tc of chunk.message.tool_calls) {
                const toolCall: ToolCall = {
                  id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  type: 'function',
                  function: {
                    name: tc.function?.name || '',
                    arguments: typeof tc.function?.arguments === 'string'
                      ? tc.function.arguments
                      : JSON.stringify(tc.function?.arguments || {}),
                  },
                };
                toolCalls.push(toolCall);
                callbacks.onToolCall?.(toolCall);
              }
            }
          } catch (e) {
            // M7-FIX: Log stream parse errors
            console.warn('[Ollama] Stream parse error:', (e as Error).message, 'line:', line.substring(0, 100));
          }
        }
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

  /** Convert our message format to Ollama format */
  private toOllamaMessage(msg: ChatMessage): any {
    const out: any = { role: msg.role, content: msg.content };
    if (msg.tool_calls) out.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) {
      // Ollama expects tool results as role: 'tool'
      out.role = 'tool';
    }
    return out;
  }
}
