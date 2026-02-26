/**
 * Local Memory System — Main entry point.
 * 
 * Initializes SQLite database + embedding engine.
 * Exports all public APIs for use by health.ts endpoints and agent context.
 */

import * as path from 'path';
import * as crypto from 'crypto';
import { initDatabase, closeDatabase, getStats, createEntity, createFact, createInsight, listEntities, getDb } from './database';
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

/**
 * Hydrate local memory DB from cloud bootstrap data.
 * Upserts entities and insights — skips duplicates by name.
 * Called once on startup or after cloud sync, NOT on every chat message.
 */
/** Strip prompt injection patterns from cloud-sourced text */
function sanitizeForStorage(text: string, maxLen = 3000): string {
  if (!text) return '';
  let clean = text.slice(0, maxLen);
  clean = clean.replace(/\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\s+(instructions?|rules?|prompts?)/gi, '[FILTERED]');
  clean = clean.replace(/\byou are now\b/gi, '[FILTERED]');
  clean = clean.replace(/\bsystem:\s/gi, '[FILTERED] ');
  return clean;
}

export function hydrateFromCloudBootstrap(cloudMemory: {
  entities?: Array<{ name: string; type?: string; description?: string; facts?: Array<{ key: string; value: string }> }>;
  insights?: Array<{ content: string; confidence?: number }>;
  relationships?: string;
}): { entities: number; insights: number; skipped: number } {
  if (!initialized) return { entities: 0, insights: 0, skipped: 0 };

  const ownerId = memoryConfig?.owner_id || 'local';
  const existing = listEntities(ownerId, undefined, 1000, 0);
  const existingNames = new Set(existing.map(e => e.name.toLowerCase()));

  let entitiesAdded = 0;
  let insightsAdded = 0;
  let skipped = 0;

  // Hydrate entities
  if (Array.isArray(cloudMemory.entities)) {
    for (const ent of cloudMemory.entities) {
      if (!ent.name) continue;
      if (existingNames.has(ent.name.toLowerCase())) {
        // Entity exists — merge any new facts
        if (ent.facts?.length) {
          try {
            const db = getDb();
            const existingEntity = existing.find(e => e.name.toLowerCase() === ent.name.toLowerCase());
            if (existingEntity) {
              const existingFacts = new Set(
                (db.prepare('SELECT key FROM facts WHERE entity_id = ?').all(existingEntity.id) as Array<{ key: string }>)
                  .map(f => f.key.toLowerCase())
              );
              for (const f of ent.facts) {
                if (!existingFacts.has(f.key.toLowerCase())) {
                  db.prepare('INSERT INTO facts (id, entity_id, key, value, source, created_at, is_dirty) VALUES (?, ?, ?, ?, ?, ?, 0)')
                    .run(crypto.randomUUID(), existingEntity.id, sanitizeForStorage(f.key, 200), sanitizeForStorage(f.value, 1000), 'cloud-sync', new Date().toISOString());
                }
              }
            }
          } catch (err: any) {
            console.warn(`[memory] Failed to merge facts for "${ent.name}": ${err.message}`);
          }
        }
        skipped++;
        continue;
      }
      try {
        const created = createEntity(ownerId, {
          name: sanitizeForStorage(ent.name, 200),
          type: ent.type || 'thing',
          description: sanitizeForStorage(ent.description || '', 2000),
          facts: ent.facts?.map(f => ({ key: sanitizeForStorage(f.key, 200), value: sanitizeForStorage(f.value, 1000) })),
        });
        // Mark as cloud-sourced and not dirty (don't sync back up)
        const db = getDb();
        db.prepare('UPDATE entities SET is_dirty = 0, cloud_id = ? WHERE id = ?')
          .run(`cloud:${ent.name}`, created.id);
        existingNames.add(ent.name.toLowerCase());
        entitiesAdded++;
      } catch (err: any) {
        console.warn(`[memory] Failed to hydrate entity "${ent.name}": ${err.message}`);
      }
    }
  }

  // Hydrate insights (with dedup)
  if (Array.isArray(cloudMemory.insights)) {
    const db = getDb();
    const existingInsights = new Set(
      (db.prepare('SELECT content FROM insights WHERE owner_id = ?').all(ownerId) as Array<{ content: string }>)
        .map(i => i.content.slice(0, 100).toLowerCase())
    );
    for (const ins of cloudMemory.insights) {
      if (!ins.content) continue;
      if (existingInsights.has(ins.content.slice(0, 100).toLowerCase())) { skipped++; continue; }
      try {
        const created = createInsight(ownerId, {
          content: sanitizeForStorage(ins.content, 2000),
          confidence: ins.confidence || 0.7,
          source_refs: ['cloud-bootstrap'],
        });
        const db = getDb();
        db.prepare('UPDATE insights SET is_dirty = 0 WHERE id = ?').run(created.id);
        insightsAdded++;
      } catch (err: any) {
        console.warn(`[memory] Failed to hydrate insight: ${err.message}`);
      }
    }
  }

  if (entitiesAdded > 0 || insightsAdded > 0) {
    console.log(`[memory] Hydrated from cloud: ${entitiesAdded} entities, ${insightsAdded} insights (${skipped} skipped as duplicates)`);
  }

  return { entities: entitiesAdded, insights: insightsAdded, skipped };
}

/**
 * Build a compact context string from local memory for a given query.
 * Used at chat-time to inject only relevant memory into the prompt.
 */
export function getRelevantContext(query: string, maxTokens = 2000): string {
  if (!initialized) return '';

  const ownerId = memoryConfig?.owner_id || 'local';
  
  // Simple text search — find entities whose name or description matches query terms
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  if (terms.length === 0) return '';
  const allEntities = listEntities(ownerId, undefined, 100, 0);
  
  // Score entities by relevance
  const scored = allEntities.map(e => {
    const text = `${e.name} ${e.type || ''} ${e.description || ''}`.toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (text.includes(term)) score++;
      if (e.name.toLowerCase().includes(term)) score += 2; // Name match weighted higher
    }
    return { entity: e, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) return '';

  // Build compact context from top matches
  const parts: string[] = ['## Memory Context'];
  let charCount = 0;
  const charLimit = maxTokens * 4; // rough chars-to-tokens

  // Get facts for top entities
  const db = getDb();
  for (const { entity } of scored.slice(0, 10)) {
    const factsRows = db.prepare('SELECT key, value FROM facts WHERE entity_id = ?').all(entity.id) as Array<{ key: string; value: string }>;
    
    let entry = `**${entity.name}** (${entity.type || 'unknown'})`;
    if (entity.description) entry += `: ${entity.description}`;
    if (factsRows.length > 0) {
      entry += '\n' + factsRows.map(f => `  - ${f.key}: ${f.value}`).join('\n');
    }

    if (charCount + entry.length > charLimit) break;
    parts.push(entry);
    charCount += entry.length;
  }

  return parts.length > 1 ? parts.join('\n\n') : '';
}

/**
 * Push dirty (locally modified) entities/facts to cloud for backup.
 * Called periodically from heartbeat or manually from dashboard.
 */
export async function pushToCloud(apiUrl: string, nodeKey: string): Promise<{ synced: number; errors: number }> {
  if (!initialized) return { synced: 0, errors: 0 };

  const db = getDb();
  const ownerId = memoryConfig?.owner_id || 'local';

  // Get dirty entities with their facts
  const dirtyEntities = db.prepare(
    'SELECT id, name, type, description, updated_at FROM entities WHERE owner_id = ? AND is_dirty = 1 LIMIT 100'
  ).all(ownerId) as Array<{ id: string; name: string; type: string; description: string; updated_at: string }>;

  if (dirtyEntities.length === 0) return { synced: 0, errors: 0 };

  // Build payload
  const entities = dirtyEntities.map(ent => {
    const facts = db.prepare('SELECT key, value, updated_at FROM facts WHERE entity_id = ?')
      .all(ent.id) as Array<{ key: string; value: string; updated_at: string }>;
    return {
      name: ent.name,
      type: ent.type,
      description: ent.description,
      updated_at: ent.updated_at,
      facts,
    };
  });

  // Get dirty relationships
  const dirtyRels = db.prepare(
    'SELECT r.relationship_type as type, e1.name as "from", e2.name as "to", r.updated_at FROM relationships r JOIN entities e1 ON r.entity_a_id = e1.id JOIN entities e2 ON r.entity_b_id = e2.id WHERE r.is_dirty = 1 LIMIT 50'
  ).all() as Array<{ type: string; from: string; to: string; updated_at: string }>;

  try {
    const res = await fetch(`${apiUrl}/api/memory/sync/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-node-key': nodeKey,
      },
      body: JSON.stringify({
        entities,
        relationships: dirtyRels,
        sync_cursor: new Date().toISOString(),
      }),
    });

    if (!res.ok) {
      console.warn(`[memory-sync] Push failed: ${res.status}`);
      return { synced: 0, errors: 1 };
    }

    const result = await res.json() as { data?: { synced?: number } };

    // Mark synced entities as clean
    const markClean = db.prepare('UPDATE entities SET is_dirty = 0 WHERE id = ?');
    const markFactsClean = db.prepare('UPDATE facts SET is_dirty = 0 WHERE entity_id = ?');
    const markRelsClean = db.prepare('UPDATE relationships SET is_dirty = 0 WHERE is_dirty = 1');

    for (const ent of dirtyEntities) {
      markClean.run(ent.id);
      markFactsClean.run(ent.id);
    }
    markRelsClean.run();

    console.log(`[memory-sync] Pushed ${result.data?.synced || 0} items to cloud`);
    return { synced: result.data?.synced || 0, errors: 0 };
  } catch (err: any) {
    console.warn(`[memory-sync] Push error: ${err.message}`);
    return { synced: 0, errors: 1 };
  }
}

// Re-export everything for clean imports
export * from './database';
export * from './embeddings';
export * from './types';
