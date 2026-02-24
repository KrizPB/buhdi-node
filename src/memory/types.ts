/**
 * Local Memory System — Type Definitions
 * 
 * Mirrors mybuhdi.com Memory API types for API compatibility.
 * Local-first with optional cloud sync.
 */

// ---- Core Entities ----

export interface MemoryEntity {
  id: string;
  owner_id: string;
  name: string;
  type: string | null;        // person, place, idea, belief, thing, event
  description: string | null;
  created_at: string;
  updated_at: string;
  // Sync metadata
  sync_version: number;
  cloud_id: string | null;
  is_dirty: number;           // 0 or 1 (SQLite has no boolean)
}

export interface MemoryFact {
  id: string;
  entity_id: string;
  key: string;
  value: string;
  source: string | null;
  created_at: string;
  sync_version: number;
  cloud_id: string | null;
  is_dirty: number;
}

export interface MemoryRelationship {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  description: string | null;
  created_at: string;
  sync_version: number;
  cloud_id: string | null;
  is_dirty: number;
}

export interface MemoryInsight {
  id: string;
  owner_id: string;
  content: string;
  confidence: number;
  source_refs: string | null;  // JSON array
  created_at: string;
  sync_version: number;
  cloud_id: string | null;
  is_dirty: number;
}

// ---- Embeddings ----

export interface EmbeddingRecord {
  id: string;
  source_table: string;       // 'entities' | 'facts' | 'insights'
  source_id: string;
  text: string;               // The text that was embedded
  embedding: Float32Array;    // The vector
  created_at: string;
}

// ---- API Types (matching mybuhdi.com) ----

export interface EntityCreateInput {
  name: string;
  type?: string;
  description?: string;
  facts?: Array<{ key: string; value: string; source?: string }>;
}

export interface EntityUpdateInput {
  name?: string;
  type?: string;
  description?: string;
}

export interface FactCreateInput {
  entity_id: string;
  key: string;
  value: string;
  source?: string;
}

export interface RelationshipCreateInput {
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  description?: string;
}

export interface InsightCreateInput {
  content: string;
  confidence?: number;
  source_refs?: string[];
}

export interface MemorySearchResult {
  id: string;
  type: 'entity' | 'fact' | 'insight';
  text: string;
  score: number;
  entity_name?: string;
  metadata?: Record<string, any>;
}

export interface MemoryContextResult {
  entities: Array<MemoryEntity & { facts: MemoryFact[]; relationships: MemoryRelationship[] }>;
  insights: MemoryInsight[];
  score: number;
}

// ---- Sync Types ----

export interface WriteJournalEntry {
  seq: number;
  timestamp: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  table_name: string;
  record_id: string;
  cloud_id: string | null;
  payload: string;             // JSON
  replayed: number;
  replay_error: string | null;
}

export interface MemoryStatus {
  state: 'dormant' | 'active' | 'recovering' | 'standalone';
  entity_count: number;
  fact_count: number;
  relationship_count: number;
  insight_count: number;
  embedding_count: number;
  journal_pending: number;
  db_size_bytes: number;
  last_mirror_sync: string | null;
  embedding_provider: string;  // 'ollama' | 'local' | 'none'
}

export interface MemoryConfig {
  enabled: boolean;
  db_path: string;             // Default: ~/.buhdi-node/memory.db
  embedding_model: string;     // Default: nomic-embed-text
  embedding_dimensions: number; // Default: 768 for nomic-embed-text
  ollama_url: string;          // Default: http://localhost:11434
  owner_id: string;            // Default: 'local'
  sync?: {
    enabled: boolean;
    cloud_url: string;
    api_key: string;
    interval_seconds: number;
  };
}
