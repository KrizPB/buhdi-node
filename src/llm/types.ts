/**
 * LLM Router — Type Definitions
 */

export type RoutingStrategy = 'local_first' | 'cloud_first' | 'local_only' | 'cloud_only' | 'cost_optimized';

export interface LLMProviderConfig {
  name: string;                // 'ollama', 'lm_studio', 'openai_compat', 'mybuhdi_cloud'
  endpoint: string;            // 'http://localhost:11434'
  model: string;               // 'qwen3:8b', 'llama3.1:70b'
  apiKey?: string;             // Only for cloud/keyed providers
  priority: number;            // Lower = preferred
  capabilities: string[];      // ['tool_calling', 'vision', 'long_context']
  maxContext: number;           // Token limit
  enabled: boolean;
}

export interface LLMRouterConfig {
  strategy: RoutingStrategy;
  providers: LLMProviderConfig[];
  maxLatencyMs: number;        // Timeout before falling back
  retries: number;             // Per-provider retry count
}

/** OpenAI-compatible message format */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;               // For tool messages
  tool_call_id?: string;       // For tool result messages
  tool_calls?: ToolCall[];     // For assistant tool-calling responses
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;         // JSON string
  };
}

/** Tool definition (OpenAI format) */
export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, any>;
  };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface CompletionResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
  provider: string;
  model: string;
  latencyMs: number;
  tokensUsed?: { prompt: number; completion: number };
}

export interface ProviderHealth {
  name: string;
  endpoint: string;
  model: string;
  available: boolean;
  lastCheck: number;
  lastLatencyMs: number;
  error?: string;
  models?: string[];           // Available models (from list endpoint)
}

export interface StreamCallback {
  onToken: (token: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onDone: (response: CompletionResponse) => void;
  onError: (error: Error) => void;
}
