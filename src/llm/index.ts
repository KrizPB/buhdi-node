/**
 * LLM System — Entry Point
 * 
 * Initializes the LLM router from config and provides
 * the public API for chat completions.
 */

export { LLMRouter, llmRouter } from './router';
export { sanitizeToolOutput, validateToolCall, sanitizeHistory, buildSystemPrompt, MAX_TOOL_CALLS_PER_TURN } from './safety';
export {
  ChatMessage, CompletionRequest, CompletionResponse,
  ToolCall, ToolDefinition, ProviderHealth,
  LLMRouterConfig, LLMProviderConfig, RoutingStrategy, StreamCallback,
} from './types';

import { llmRouter } from './router';
import { LLMRouterConfig, LLMProviderConfig } from './types';
import { loadConfig } from '../config';

/**
 * Initialize the LLM router from buhdi-node config.
 * Reads `llm` section from config.json.
 */
export function initLLMRouter(): void {
  const config = loadConfig();
  const llmConfig = config.llm as Partial<LLMRouterConfig> | undefined;

  if (!llmConfig?.providers?.length) {
    // Auto-detect Ollama on default port
    console.log('🧠 No LLM config found. Auto-detecting Ollama...');
    llmRouter.updateConfig({
      strategy: 'local_first',
      providers: [
        {
          name: 'ollama',
          endpoint: 'http://localhost:11434',
          model: 'llama3.1:8b',
          priority: 1,
          capabilities: ['tool_calling'],
          maxContext: 32768,
          enabled: true,
        },
      ],
      maxLatencyMs: 30_000,
      retries: 1,
    });
  } else {
    llmRouter.updateConfig({
      strategy: llmConfig.strategy || 'local_first',
      providers: llmConfig.providers,
      maxLatencyMs: llmConfig.maxLatencyMs || 30_000,
      retries: llmConfig.retries ?? 1,
    });
  }
}
