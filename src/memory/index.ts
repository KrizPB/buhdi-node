/**
 * Local Memory System — Main entry point.
 * 
 * Initializes SQLite database + embedding engine.
 * Exports all public APIs for use by health.ts endpoints and agent context.
 */

import * as path from 'path';
import { initDatabase, closeDatabase, getStats } from './database';
import { configureEmbeddings, checkEmbeddingHealth, isEmbeddingAvailable, getEmbeddingProvider } from './embeddings';
import { MemoryConfig, MemoryStatus } from './types';

let initialized = false;
let memoryConfig: MemoryConfig | null = null;

export async function initMemory(config?: Partial<MemoryConfig>): Promise<void> {
  if (initialized) return;

  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const defaults: MemoryConfig = {
    enabled: true,
    db_path: path.join(homeDir, '.buhdi-node', 'memory.db'),
    owner_id: 'local',
  };

  memoryConfig = { ...defaults, ...config };

  if (!memoryConfig.enabled) {
    console.log('[memory] Local memory disabled in config.');
    return;
  }

  // Init SQLite
  initDatabase(memoryConfig.db_path);
  console.log(`[memory] Database initialized at ${memoryConfig.db_path}`);

  // Configure embeddings — supports any provider (Ollama, LM Studio, LocalAI, vLLM, etc.)
  const embConfig = memoryConfig.embedding || {};
  configureEmbeddings({
    provider: embConfig.provider,
    endpoint: embConfig.endpoint || memoryConfig.ollama_url,
    model: embConfig.model || memoryConfig.embedding_model || 'nomic-embed-text',
    dimensions: embConfig.dimensions || memoryConfig.embedding_dimensions || 768,
    api_key: embConfig.api_key,
  });

  // Auto-detect and check embedding provider
  const embeddingOk = await checkEmbeddingHealth();
  if (embeddingOk) {
    console.log(`[memory] Embeddings ready via ${getEmbeddingProvider()}`);
  } else {
    console.log(`[memory] Embeddings unavailable — semantic search will fall back to text matching`);
    console.log(`[memory] To enable: run any local LLM server with embedding support (Ollama, LM Studio, LocalAI, etc.)`);
  }

  initialized = true;
}

export function getMemoryStatus(): MemoryStatus {
  if (!initialized || !memoryConfig) {
    return {
      state: 'standalone',
      entity_count: 0, fact_count: 0, relationship_count: 0,
      insight_count: 0, embedding_count: 0, journal_pending: 0,
      db_size_bytes: 0,
      last_mirror_sync: null,
      embedding_provider: 'none',
    };
  }

  const stats = getStats();
  let dbSize = 0;
  try {
    const fs = require('fs');
    dbSize = fs.statSync(memoryConfig.db_path).size;
  } catch {}

  return {
    state: memoryConfig.sync?.enabled ? 'dormant' : 'standalone',
    entity_count: stats.entities,
    fact_count: stats.facts,
    relationship_count: stats.relationships,
    insight_count: stats.insights,
    embedding_count: stats.embeddings,
    journal_pending: stats.journal_pending,
    db_size_bytes: dbSize,
    last_mirror_sync: null, // TODO: read from sync_state
    embedding_provider: isEmbeddingAvailable() ? getEmbeddingProvider() : 'none',
  };
}

export function shutdownMemory(): void {
  closeDatabase();
  initialized = false;
}

export function isMemoryInitialized(): boolean {
  return initialized;
}

// Re-export everything for clean imports
export * from './database';
export * from './embeddings';
export * from './types';
