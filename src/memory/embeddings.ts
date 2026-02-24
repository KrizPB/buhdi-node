/**
 * Local Embedding Engine — Generate and search vector embeddings.
 * 
 * Strategy: Use Ollama for embeddings (nomic-embed-text) when available.
 * Embeddings stored as BLOBs in SQLite. Cosine similarity computed in JS.
 * For personal memory volumes (<100K records), this is plenty fast.
 */

import { getDb } from './database';
import { EmbeddingRecord, MemorySearchResult } from './types';
import * as crypto from 'crypto';

// ---- Configuration ----

let ollamaUrl = 'http://localhost:11434';
let embeddingModel = 'nomic-embed-text';
let embeddingDimensions = 768;
let isAvailable = false;

export function configureEmbeddings(config: {
  ollama_url?: string;
  model?: string;
  dimensions?: number;
}): void {
  if (config.ollama_url) {
    // M3-FIX: Only allow localhost Ollama URLs to prevent SSRF
    try {
      const parsed = new URL(config.ollama_url);
      const host = parsed.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
        ollamaUrl = config.ollama_url;
      } else {
        console.warn(`[memory] Ignoring non-localhost ollama_url: ${config.ollama_url}`);
      }
    } catch {
      console.warn(`[memory] Invalid ollama_url: ${config.ollama_url}`);
    }
  }
  if (config.model) embeddingModel = config.model;
  if (config.dimensions) embeddingDimensions = config.dimensions;
}

// ---- Health Check ----

export async function checkEmbeddingHealth(): Promise<boolean> {
  try {
    const resp = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return (isAvailable = false);

    const data = await resp.json() as { models?: Array<{ name: string }> };
    const models = data.models || [];
    isAvailable = models.some((m: { name: string }) =>
      m.name === embeddingModel || m.name.startsWith(embeddingModel + ':')
    );

    if (!isAvailable) {
      console.log(`[memory] Embedding model "${embeddingModel}" not found in Ollama. Available: ${models.map((m: { name: string }) => m.name).join(', ')}`);
    }
    return isAvailable;
  } catch {
    isAvailable = false;
    return false;
  }
}

export function isEmbeddingAvailable(): boolean {
  return isAvailable;
}

// ---- Generate Embedding ----

export async function generateEmbedding(text: string): Promise<Float32Array | null> {
  if (!isAvailable) return null;

  try {
    const resp = await fetch(`${ollamaUrl}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embeddingModel, input: text }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) return null;

    const data = await resp.json() as { embeddings?: number[][] };
    if (!data.embeddings?.[0]) return null;

    return new Float32Array(data.embeddings[0]);
  } catch (err) {
    console.error('[memory] Embedding generation failed:', (err as Error).message);
    return null;
  }
}

// ---- Store Embedding ----

export async function storeEmbedding(
  sourceTable: string,
  sourceId: string,
  text: string
): Promise<boolean> {
  const embedding = await generateEmbedding(text);
  if (!embedding) return false;

  const d = getDb();
  const id = crypto.randomBytes(16).toString('hex');

  // Upsert: delete old embedding for this source, insert new
  d.prepare('DELETE FROM embeddings WHERE source_table = ? AND source_id = ?').run(sourceTable, sourceId);
  d.prepare(`
    INSERT INTO embeddings (id, source_table, source_id, text, embedding, dimensions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, sourceTable, sourceId, text, Buffer.from(embedding.buffer), embeddingDimensions, new Date().toISOString());

  return true;
}

// ---- Batch Embed ----

export async function embedEntity(entityId: string): Promise<number> {
  const d = getDb();
  const entity = d.prepare('SELECT * FROM entities WHERE id = ?').get(entityId) as any;
  if (!entity) return 0;

  const facts = d.prepare('SELECT * FROM facts WHERE entity_id = ?').all(entityId) as any[];

  let count = 0;

  // Embed entity description
  const entityText = [entity.name, entity.type, entity.description].filter(Boolean).join(' — ');
  if (await storeEmbedding('entities', entity.id, entityText)) count++;

  // Embed each fact
  for (const fact of facts) {
    const factText = `${entity.name}: ${fact.key} = ${fact.value}`;
    if (await storeEmbedding('facts', fact.id, factText)) count++;
  }

  return count;
}

export async function embedInsight(insightId: string): Promise<boolean> {
  const d = getDb();
  const insight = d.prepare('SELECT * FROM insights WHERE id = ?').get(insightId) as any;
  if (!insight) return false;

  return storeEmbedding('insights', insight.id, insight.content);
}

// ---- Semantic Search ----

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export async function semanticSearch(
  query: string,
  options: { limit?: number; minScore?: number; tables?: string[] } = {}
): Promise<MemorySearchResult[]> {
  const { limit = 10, minScore = 0.3, tables } = options;

  const queryEmbedding = await generateEmbedding(query);
  if (!queryEmbedding) {
    // Fallback to text search if embeddings unavailable
    return textFallbackSearch(query, limit);
  }

  const d = getDb();
  let rows: any[];

  if (tables?.length) {
    const placeholders = tables.map(() => '?').join(',');
    rows = d.prepare(`SELECT * FROM embeddings WHERE source_table IN (${placeholders})`).all(...tables);
  } else {
    rows = d.prepare('SELECT * FROM embeddings').all();
  }

  const results: MemorySearchResult[] = [];

  for (const row of rows) {
    const stored = new Float32Array(new Uint8Array(row.embedding).buffer);
    const score = cosineSimilarity(queryEmbedding, stored);

    if (score >= minScore) {
      results.push({
        id: row.source_id,
        type: row.source_table === 'entities' ? 'entity'
            : row.source_table === 'facts' ? 'fact'
            : 'insight',
        text: row.text,
        score,
        entity_name: getEntityName(d, row.source_table, row.source_id),
      });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ---- Context Search (enriched, for AI injection) ----

export async function contextSearch(
  query: string,
  options: { limit?: number; minScore?: number } = {}
): Promise<{ entities: any[]; insights: any[]; query: string }> {
  const searchResults = await semanticSearch(query, { ...options, limit: 20 });
  const d = getDb();

  // Collect unique entity IDs from results
  const entityIds = new Set<string>();
  const insightIds = new Set<string>();

  for (const r of searchResults) {
    if (r.type === 'entity') entityIds.add(r.id);
    else if (r.type === 'fact') {
      const fact = d.prepare('SELECT entity_id FROM facts WHERE id = ?').get(r.id) as { entity_id: string } | undefined;
      if (fact) entityIds.add(fact.entity_id);
    }
    else if (r.type === 'insight') insightIds.add(r.id);
  }

  // Hydrate entities with facts
  const entities = [...entityIds].slice(0, options.limit || 5).map(id => {
    const entity = d.prepare('SELECT * FROM entities WHERE id = ?').get(id) as any;
    if (!entity) return null;
    entity.facts = d.prepare('SELECT * FROM facts WHERE entity_id = ?').all(id);
    entity.relationships = d.prepare(`
      SELECT r.*, 
        se.name as source_name, te.name as target_name
      FROM relationships r
      JOIN entities se ON r.source_entity_id = se.id
      JOIN entities te ON r.target_entity_id = te.id
      WHERE r.source_entity_id = ? OR r.target_entity_id = ?
    `).all(id, id);
    return entity;
  }).filter(Boolean);

  const insights = [...insightIds].slice(0, 3).map(id =>
    d.prepare('SELECT * FROM insights WHERE id = ?').get(id)
  ).filter(Boolean);

  return { entities, insights, query };
}

// ---- Text Fallback (when embeddings unavailable) ----

function textFallbackSearch(query: string, limit: number): MemorySearchResult[] {
  const d = getDb();
  const pattern = `%${query}%`;

  const entities = d.prepare(`
    SELECT id, name, type, description FROM entities
    WHERE name LIKE ? OR description LIKE ?
    LIMIT ?
  `).all(pattern, pattern, limit) as any[];

  const facts = d.prepare(`
    SELECT f.id, f.key, f.value, e.name as entity_name
    FROM facts f JOIN entities e ON f.entity_id = e.id
    WHERE f.key LIKE ? OR f.value LIKE ?
    LIMIT ?
  `).all(pattern, pattern, limit) as any[];

  const results: MemorySearchResult[] = [];

  for (const e of entities) {
    results.push({
      id: e.id,
      type: 'entity',
      text: [e.name, e.type, e.description].filter(Boolean).join(' — '),
      score: 0.5, // Fixed score for text match
      entity_name: e.name,
    });
  }

  for (const f of facts) {
    results.push({
      id: f.id,
      type: 'fact',
      text: `${f.entity_name}: ${f.key} = ${f.value}`,
      score: 0.5,
      entity_name: f.entity_name,
    });
  }

  return results.slice(0, limit);
}

// ---- Helpers ----

function getEntityName(d: any, sourceTable: string, sourceId: string): string | undefined {
  if (sourceTable === 'entities') {
    const e = d.prepare('SELECT name FROM entities WHERE id = ?').get(sourceId) as { name: string } | undefined;
    return e?.name;
  }
  if (sourceTable === 'facts') {
    const f = d.prepare(`
      SELECT e.name FROM facts f JOIN entities e ON f.entity_id = e.id WHERE f.id = ?
    `).get(sourceId) as { name: string } | undefined;
    return f?.name;
  }
  return undefined;
}

// ---- Reindex All ----

export async function reindexAll(): Promise<{ total: number; embedded: number; errors: number }> {
  const d = getDb();
  let embedded = 0, errors = 0;

  const entities = d.prepare('SELECT id FROM entities').all() as { id: string }[];
  for (const e of entities) {
    try {
      embedded += await embedEntity(e.id);
    } catch { errors++; }
  }

  const insights = d.prepare('SELECT id FROM insights').all() as { id: string }[];
  for (const i of insights) {
    try {
      if (await embedInsight(i.id)) embedded++;
    } catch { errors++; }
  }

  return { total: entities.length + insights.length, embedded, errors };
}
