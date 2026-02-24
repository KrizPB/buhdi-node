/**
 * LLM Router
 * 
 * Routes completion requests to the best available provider
 * based on strategy, health, and capabilities.
 */

import {
  LLMRouterConfig, LLMProviderConfig, RoutingStrategy,
  CompletionRequest, CompletionResponse, ProviderHealth,
  StreamCallback
} from './types';
import { OllamaProvider } from './providers/ollama';
import { OpenAICompatProvider } from './providers/openai-compat';
import { AnthropicProvider } from './providers/anthropic';
import { addActivity, broadcastToDashboard } from '../health';

type Provider = OllamaProvider | OpenAICompatProvider | AnthropicProvider;

/** Default config when none specified */
const DEFAULT_CONFIG: LLMRouterConfig = {
  strategy: 'local_first',
  providers: [],
  maxLatencyMs: 30_000,
  retries: 1,
};

export class LLMRouter {
  private config: LLMRouterConfig;
  private providers: Provider[] = [];
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null;
  private stats = {
    totalRequests: 0,
    totalFallbacks: 0,
    totalErrors: 0,
    byProvider: new Map<string, { requests: number; errors: number; totalLatency: number }>(),
  };

  constructor(config?: Partial<LLMRouterConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Initialize providers from config */
  init(): void {
    this.providers = [];
    
    for (const pc of this.config.providers) {
      if (!pc.enabled) continue;
      const provider = this.createProvider(pc);
      if (provider) {
        this.providers.push(provider);
        this.stats.byProvider.set(pc.name, { requests: 0, errors: 0, totalLatency: 0 });
      }
    }

    console.log(`🧠 LLM Router: ${this.providers.length} providers, strategy: ${this.config.strategy}`);

    // Start health check loop (every 30s)
    if (this.providers.length > 0) {
      this.runHealthChecks();
      this.healthCheckInterval = setInterval(() => this.runHealthChecks(), 30_000);
    }
  }

  /** Stop health checks */
  destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  private createProvider(config: LLMProviderConfig): Provider | null {
    // Check explicit type first, then fall back to name-based detection
    const type = config.type?.toLowerCase() || config.name?.toLowerCase() || '';
    
    if (type === 'ollama') return new OllamaProvider(config);
    if (type === 'anthropic') return new AnthropicProvider(config);
    
    // Name-based detection for backward compat
    switch (config.name) {
      case 'ollama':
        return new OllamaProvider(config);
      case 'anthropic':
        return new AnthropicProvider(config);
      case 'lm_studio':
      case 'openai_compat':
      case 'mybuhdi_cloud':
      case 'openai':
      case 'openrouter':
        return new OpenAICompatProvider(config);
      default:
        // Auto-detect: if endpoint is api.anthropic.com or key starts with sk-ant-oat, use Anthropic
        if (config.endpoint?.includes('api.anthropic.com') || config.apiKey?.startsWith('sk-ant-oat')) {
          return new AnthropicProvider(config);
        }
        return new OpenAICompatProvider(config);
    }
  }

  /** Run health checks on all providers */
  async runHealthChecks(): Promise<void> {
    await Promise.all(this.providers.map(p => p.healthCheck()));
    
    // Broadcast health to dashboard
    broadcastToDashboard({
      type: 'llm.health',
      providers: this.getHealthStatus(),
      strategy: this.config.strategy,
    });
  }

  /** Get health status for all providers */
  getHealthStatus(): ProviderHealth[] {
    return this.providers.map(p => p.getHealth());
  }

  /** Get stats summary */
  getStats() {
    return {
      totalRequests: this.stats.totalRequests,
      totalFallbacks: this.stats.totalFallbacks,
      totalErrors: this.stats.totalErrors,
      strategy: this.config.strategy,
      providerCount: this.providers.length,
      byProvider: Object.fromEntries(this.stats.byProvider),
    };
  }

  /** Check if any provider is available */
  hasAvailableProvider(): boolean {
    return this.providers.some(p => p.getHealth().available);
  }

  /**
   * Route a completion request to the best provider.
   * Handles fallback based on strategy.
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.stats.totalRequests++;
    const ordered = this.getProviderOrder();

    if (ordered.length === 0) {
      return {
        content: 'No LLM providers configured or available. Configure one in Settings → AI Engine.',
        toolCalls: [],
        finishReason: 'error',
        provider: 'none',
        model: 'none',
        latencyMs: 0,
      };
    }

    let lastError: string = '';
    for (let i = 0; i < ordered.length; i++) {
      const provider = ordered[i];
      const health = provider.getHealth();

      if (!health.available && i < ordered.length - 1) {
        // Skip unavailable unless it's our last resort
        continue;
      }

      for (let retry = 0; retry <= this.config.retries; retry++) {
        try {
          const result = await provider.complete(request);

          if (result.finishReason === 'error') {
            lastError = `${health.name} returned error`;
            const stats = this.stats.byProvider.get(health.name);
            if (stats) stats.errors++;
            break; // Try next provider
          }

          // Success
          const stats = this.stats.byProvider.get(health.name);
          if (stats) {
            stats.requests++;
            stats.totalLatency += result.latencyMs;
          }

          if (i > 0) {
            this.stats.totalFallbacks++;
            addActivity('🔄', `LLM fallback: ${ordered[0].getHealth().name} → ${health.name}`);
          }

          return result;
        } catch (err: any) {
          lastError = err.message;
          if (retry === this.config.retries) break;
        }
      }
    }

    // All providers failed
    this.stats.totalErrors++;
    return {
      content: `All LLM providers failed. Last error: ${lastError}`,
      toolCalls: [],
      finishReason: 'error',
      provider: 'none',
      model: 'none',
      latencyMs: 0,
    };
  }

  /**
   * Stream a completion with fallback.
   */
  async stream(request: CompletionRequest, callbacks: StreamCallback): Promise<void> {
    this.stats.totalRequests++;
    const ordered = this.getProviderOrder();

    if (ordered.length === 0) {
      callbacks.onError(new Error('No LLM providers available'));
      return;
    }

    // Try first available provider (no mid-stream fallback)
    for (const provider of ordered) {
      const health = provider.getHealth();
      if (!health.available) continue;

      try {
        await provider.stream(request, callbacks);
        const stats = this.stats.byProvider.get(health.name);
        if (stats) stats.requests++;
        return;
      } catch (err: any) {
        const stats = this.stats.byProvider.get(health.name);
        if (stats) stats.errors++;
        // Try next provider
      }
    }

    callbacks.onError(new Error('All LLM providers failed'));
  }

  /** Order providers based on routing strategy */
  private getProviderOrder(): Provider[] {
    const available = this.providers.filter(p => p.getHealth().available);
    const unavailable = this.providers.filter(p => !p.getHealth().available);

    switch (this.config.strategy) {
      case 'local_only':
        // Only local providers (Ollama, LM Studio), skip cloud entirely
        return available.filter(p => {
          const h = p.getHealth();
          return h.name === 'ollama' || h.name === 'lm_studio' || h.name === 'openai_compat';
        });

      case 'cloud_only':
        // Only cloud providers
        return available.filter(p => {
          const h = p.getHealth();
          return h.name === 'mybuhdi_cloud' || h.name === 'openai' || h.name === 'openrouter';
        });

      case 'local_first':
        // Sort: local available first, then cloud available, then unavailable as last resort
        return [
          ...available.filter(p => this.isLocal(p)),
          ...available.filter(p => !this.isLocal(p)),
          ...unavailable.slice(0, 1), // One fallback attempt
        ];

      case 'cloud_first':
        return [
          ...available.filter(p => !this.isLocal(p)),
          ...available.filter(p => this.isLocal(p)),
          ...unavailable.slice(0, 1),
        ];

      case 'cost_optimized':
        // Local is free, cloud costs money — prefer local for simple tasks
        // (For now, same as local_first. Could add token estimation later.)
        return [
          ...available.filter(p => this.isLocal(p)),
          ...available.filter(p => !this.isLocal(p)),
        ];

      default:
        return [...available, ...unavailable.slice(0, 1)];
    }
  }

  private isLocal(provider: Provider): boolean {
    const name = provider.getHealth().name;
    return name === 'ollama' || name === 'lm_studio' || name === 'openai_compat';
  }

  /** Update config at runtime (e.g., user changes model in dashboard) */
  updateConfig(partial: Partial<LLMRouterConfig>): void {
    this.destroy();
    Object.assign(this.config, partial);
    this.init();
  }

  /** Add a provider at runtime */
  addProvider(config: LLMProviderConfig): void {
    this.config.providers.push(config);
    const provider = this.createProvider(config);
    if (provider) {
      this.providers.push(provider);
      this.stats.byProvider.set(config.name, { requests: 0, errors: 0, totalLatency: 0 });
      provider.healthCheck();
    }
  }
}

// Singleton
export const llmRouter = new LLMRouter();
