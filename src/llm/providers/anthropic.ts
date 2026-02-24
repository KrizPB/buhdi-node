/**
 * Anthropic LLM Provider (Native API)
 * 
 * Uses /v1/messages endpoint with proper Anthropic format.
 * Supports both API keys (x-api-key) and OAuth tokens (Bearer).
 * Auto-detects OAuth tokens by 'sk-ant-oat' prefix.
 */

import {
  LLMProviderConfig, ChatMessage, CompletionRequest, CompletionResponse,
  ToolCall, ProviderHealth, StreamCallback
} from '../types';

export class AnthropicProvider {
  private config: LLMProviderConfig;
  private health: ProviderHealth;

  constructor(config: LLMProviderConfig) {
    this.config = config;
    this.health = {
      name: config.name,
      endpoint: config.endpoint || 'https://api.anthropic.com',
      model: config.model,
      available: false,
      lastCheck: 0,
      lastLatencyMs: 0,
    };
  }

  private get endpoint(): string {
    return this.config.endpoint || 'https://api.anthropic.com';
  }

  private get isOAuth(): boolean {
    return !!this.config.apiKey?.includes('sk-ant-oat');
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    };

    if (!this.config.apiKey) return headers;

    if (this.isOAuth) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      headers['user-agent'] = 'buhdi-node/1.0 (local, api)';
    } else {
      headers['x-api-key'] = this.config.apiKey;
    }

    return headers;
  }

  /** Convert OpenAI-style messages to Anthropic format */
  private convertMessages(messages: ChatMessage[]): { system: string; messages: any[] } {
    const systemMsgs = messages.filter(m => m.role === 'system');
    const system = systemMsgs.map(m => m.content).join('\n\n');
    
    const chatMessages: any[] = [];
    for (const m of messages) {
      if (m.role === 'system') continue;
      
      if (m.role === 'assistant' && m.tool_calls?.length) {
        // Convert tool calls to Anthropic format
        const content: any[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls) {
          let input: any = {};
          try { input = JSON.parse(tc.function.arguments); } catch {}
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input,
          });
        }
        chatMessages.push({ role: 'assistant', content });
      } else if (m.role === 'tool') {
        chatMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content,
          }],
        });
      } else {
        chatMessages.push({ role: m.role, content: m.content });
      }
    }

    return { system, messages: chatMessages };
  }

  /** Convert Anthropic tool definitions from OpenAI format */
  private convertTools(tools?: any[]): any[] | undefined {
    if (!tools?.length) return undefined;
    return tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  getHealth(): ProviderHealth { return this.health; }

  async healthCheck(): Promise<boolean> {
    const start = Date.now();
    try {
      const headers = this.buildHeaders();
      const res = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(10000),
      });

      this.health.lastCheck = Date.now();
      this.health.lastLatencyMs = Date.now() - start;

      if (res.ok) {
        this.health.available = true;
        this.health.models = [this.config.model];
        this.health.error = undefined;
        return true;
      }

      const errText = await res.text().catch(() => '');
      this.health.available = false;
      this.health.error = `${res.status}: ${errText.substring(0, 200)}`;
      return false;
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
    const headers = this.buildHeaders();
    const { system, messages } = this.convertMessages(request.messages);

    const body: any = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? 2048,
      messages,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const tools = this.convertTools(request.tools);
    if (tools) body.tools = tools;

    try {
      const res = await fetch(`${this.endpoint}/v1/messages`, {
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
      const latency = Date.now() - start;
      this.health.lastLatencyMs = latency;

      // Parse Anthropic response
      let content: string | null = null;
      const toolCalls: ToolCall[] = [];

      for (const block of (data.content || [])) {
        if (block.type === 'text') {
          content = (content || '') + block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input || {}),
            },
          });
        }
      }

      return {
        content,
        toolCalls,
        finishReason: data.stop_reason === 'tool_use' ? 'tool_calls'
          : data.stop_reason === 'max_tokens' ? 'length'
          : 'stop',
        provider: this.config.name,
        model: this.config.model,
        latencyMs: latency,
        tokensUsed: data.usage ? {
          prompt: data.usage.input_tokens || 0,
          completion: data.usage.output_tokens || 0,
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
    const headers = this.buildHeaders();
    const { system, messages } = this.convertMessages(request.messages);

    const body: any = {
      model: this.config.model,
      max_tokens: request.maxTokens ?? 2048,
      messages,
      stream: true,
    };
    if (system) body.system = system;
    if (request.temperature !== undefined) body.temperature = request.temperature;

    const tools = this.convertTools(request.tools);
    if (tools) body.tools = tools;

    try {
      const res = await fetch(`${this.endpoint}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`${this.config.name} ${res.status}: ${errText.substring(0, 200)}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let fullContent = '';
      const toolCalls: ToolCall[] = [];
      const activeToolUse: Map<number, { id: string; name: string; args: string }> = new Map();
      let buffer = '';
      let currentToolIndex = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const payload = line.slice(6).trim();
          if (!payload) continue;

          try {
            const event = JSON.parse(payload);

            if (event.type === 'content_block_start') {
              if (event.content_block?.type === 'tool_use') {
                activeToolUse.set(event.index, {
                  id: event.content_block.id,
                  name: event.content_block.name,
                  args: '',
                });
              }
            } else if (event.type === 'content_block_delta') {
              if (event.delta?.type === 'text_delta') {
                fullContent += event.delta.text;
                callbacks.onToken(event.delta.text);
              } else if (event.delta?.type === 'input_json_delta') {
                const tool = activeToolUse.get(event.index);
                if (tool) tool.args += event.delta.partial_json;
              }
            } else if (event.type === 'content_block_stop') {
              const tool = activeToolUse.get(event.index);
              if (tool) {
                const tc: ToolCall = {
                  id: tool.id,
                  type: 'function',
                  function: { name: tool.name, arguments: tool.args || '{}' },
                };
                toolCalls.push(tc);
                callbacks.onToolCall?.(tc);
                activeToolUse.delete(event.index);
              }
            }
          } catch (e) {
            console.warn(`[${this.config.name}] Stream parse error:`, (e as Error).message);
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
}
