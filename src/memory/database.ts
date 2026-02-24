/**
 * Local Memory Database — SQLite storage for entities, facts, relationships, insights.
 * 
 * Uses better-sqlite3 for synchronous, fast, zero-config persistence.
 * Schema mirrors mybuhdi.com Supabase tables for API compatibility.
 */

import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';
import {
  MemoryEntity, MemoryFact, MemoryRelationship, MemoryInsight,
  EntityCreateInput, EntityUpdateInput, FactCreateInput,
  RelationshipCreateInput, InsightCreateInput, WriteJournalEntry,
} from './types';

let db: Database.Database | null = null;

function genId(): string {
  return crypto.randomBytes(16).toString('hex');
}

function now(): string {
  return new Date().toISOString();
}

// ---- Init ----

export function initDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');

  createSchema(db);
  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Memory database not initialized. Call initDatabase() first.');
  return db;
}

export function closeDatabase(): void {
  if (db) { db.close(); db = null; }
}

function createSchema(d: Database.Database): void {
  d.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      description TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sync_version INTEGER DEFAULT 0,
      cloud_id TEXT,
      is_dirty INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      source TEXT,
      created_at TEXT NOT NULL,
      sync_version INTEGER DEFAULT 0,
      cloud_id TEXT,
      is_dirty INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS relationships (
      id TEXT PRIMARY KEY,
      source_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      relationship_type TEXT NOT NULL,
      description TEXT,
      created_at TEXT NOT NULL,
      sync_version INTEGER DEFAULT 0,
      cloud_id TEXT,
      is_dirty INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS insights (
      id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL DEFAULT 0.5,
      source_refs TEXT,
      created_at TEXT NOT NULL,
      sync_version INTEGER DEFAULT 0,
      cloud_id TEXT,
      is_dirty INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      source_table TEXT NOT NULL,
      source_id TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      dimensions INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS write_journal (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      operation TEXT NOT NULL,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      cloud_id TEXT,
      payload TEXT NOT NULL,
      replayed INTEGER DEFAULT 0,
      replay_error TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_id);
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);
    CREATE INDEX IF NOT EXISTS idx_facts_key ON facts(key);
    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_entity_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_entity_id);
    CREATE INDEX IF NOT EXISTS idx_embeddings_source ON embeddings(source_table, source_id);
    CREATE INDEX IF NOT EXISTS idx_journal_pending ON write_journal(replayed) WHERE replayed = 0;
  `);
}

// ---- Entity CRUD ----

export function createEntity(ownerId: string, input: EntityCreateInput): MemoryEntity {
  const d = getDb();
  const id = genId();
  const ts = now();

  const entity = d.transaction(() => {
    d.prepare(`
      INSERT INTO entities (id, owner_id, name, type, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, ownerId, input.name, input.type || null, input.description || null, ts, ts);

    if (input.facts?.length) {
      const factStmt = d.prepare(`
        INSERT INTO facts (id, entity_id, key, value, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const f of input.facts) {
        factStmt.run(genId(), id, f.key, f.value, f.source || null, ts);
      }
    }

    journalWrite(d, 'INSERT', 'entities', id, null, { ...input, id });
    return d.prepare('SELECT * FROM entities WHERE id = ?').get(id) as MemoryEntity;
  })();

  return entity;
}

export function getEntity(id: string): (MemoryEntity & { facts: MemoryFact[]; relationships: MemoryRelationship[] }) | null {
  const d = getDb();
  const entity = d.prepare('SELECT * FROM entities WHERE id = ?').get(id) as MemoryEntity | undefined;
  if (!entity) return null;

  const facts = d.prepare('SELECT * FROM facts WHERE entity_id = ? ORDER BY created_at').all(id) as MemoryFact[];
  const relationships = d.prepare(`
    SELECT * FROM relationships 
    WHERE source_entity_id = ? OR target_entity_id = ?
    ORDER BY created_at
  `).all(id, id) as MemoryRelationship[];

  return { ...entity, facts, relationships };
}

export function listEntities(ownerId: string, query?: string, limit = 50, offset = 0): MemoryEntity[] {
  const d = getDb();
  if (query) {
    return d.prepare(`
      SELECT * FROM entities 
      WHERE owner_id = ? AND (name LIKE ? OR description LIKE ? OR type LIKE ?)
      ORDER BY updated_at DESC LIMIT ? OFFSET ?
    `).all(ownerId, `%${query}%`, `%${query}%`, `%${query}%`, limit, offset) as MemoryEntity[];
  }
  return d.prepare(`
    SELECT * FROM entities WHERE owner_id = ?
    ORDER BY updated_at DESC LIMIT ? OFFSET ?
  `).all(ownerId, limit, offset) as MemoryEntity[];
}

export function updateEntity(id: string, input: EntityUpdateInput): MemoryEntity | null {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM entities WHERE id = ?').get(id) as MemoryEntity | undefined;
  if (!existing) return null;

  const updates: string[] = [];
  const values: any[] = [];

  if (input.name !== undefined) { updates.push('name = ?'); values.push(input.name); }
  if (input.type !== undefined) { updates.push('type = ?'); values.push(input.type); }
  if (input.description !== undefined) { updates.push('description = ?'); values.push(input.description); }

  if (updates.length === 0) return existing;

  updates.push('updated_at = ?', 'is_dirty = 1');
  values.push(now(), 1, id);

  d.prepare(`UPDATE entities SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  journalWrite(d, 'UPDATE', 'entities', id, existing.cloud_id, input);

  return d.prepare('SELECT * FROM entities WHERE id = ?').get(id) as MemoryEntity;
}

export function deleteEntity(id: string): boolean {
  const d = getDb();
  const existing = d.prepare('SELECT cloud_id FROM entities WHERE id = ?').get(id) as { cloud_id: string | null } | undefined;
  if (!existing) return false;

  d.transaction(() => {
    d.prepare('DELETE FROM embeddings WHERE source_table = ? AND source_id = ?').run('entities', id);
    // Facts and relationships cascade
    d.prepare('DELETE FROM entities WHERE id = ?').run(id);
    journalWrite(d, 'DELETE', 'entities', id, existing.cloud_id, { id });
  })();

  return true;
}

// ---- Fact CRUD ----

export function createFact(ownerId: string, input: FactCreateInput): MemoryFact {
  const d = getDb();
  const id = genId();
  const ts = now();

  d.prepare(`
    INSERT INTO facts (id, entity_id, key, value, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.entity_id, input.key, input.value, input.source || null, ts);

  // Touch parent entity
  d.prepare('UPDATE entities SET updated_at = ?, is_dirty = 1 WHERE id = ?').run(ts, input.entity_id);
  journalWrite(d, 'INSERT', 'facts', id, null, input);

  return d.prepare('SELECT * FROM facts WHERE id = ?').get(id) as MemoryFact;
}

export function deleteFact(id: string): boolean {
  const d = getDb();
  const existing = d.prepare('SELECT cloud_id, entity_id FROM facts WHERE id = ?').get(id) as { cloud_id: string | null; entity_id: string } | undefined;
  if (!existing) return false;

  d.prepare('DELETE FROM embeddings WHERE source_table = ? AND source_id = ?').run('facts', id);
  d.prepare('DELETE FROM facts WHERE id = ?').run(id);
  d.prepare('UPDATE entities SET updated_at = ?, is_dirty = 1 WHERE id = ?').run(now(), existing.entity_id);
  journalWrite(d, 'DELETE', 'facts', id, existing.cloud_id, { id });

  return true;
}

// ---- Relationship CRUD ----

export function createRelationship(ownerId: string, input: RelationshipCreateInput): MemoryRelationship {
  const d = getDb();
  const id = genId();
  const ts = now();

  d.prepare(`
    INSERT INTO relationships (id, source_entity_id, target_entity_id, relationship_type, description, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.source_entity_id, input.target_entity_id, input.relationship_type, input.description || null, ts);

  journalWrite(d, 'INSERT', 'relationships', id, null, input);
  return d.prepare('SELECT * FROM relationships WHERE id = ?').get(id) as MemoryRelationship;
}

export function deleteRelationship(id: string): boolean {
  const d = getDb();
  const existing = d.prepare('SELECT cloud_id FROM relationships WHERE id = ?').get(id) as { cloud_id: string | null } | undefined;
  if (!existing) return false;

  d.prepare('DELETE FROM relationships WHERE id = ?').run(id);
  journalWrite(d, 'DELETE', 'relationships', id, existing.cloud_id, { id });
  return true;
}

// ---- Insight CRUD ----

export function createInsight(ownerId: string, input: InsightCreateInput): MemoryInsight {
  const d = getDb();
  const id = genId();
  const ts = now();

  d.prepare(`
    INSERT INTO insights (id, owner_id, content, confidence, source_refs, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, ownerId, input.content, input.confidence ?? 0.5, JSON.stringify(input.source_refs || []), ts);

  journalWrite(d, 'INSERT', 'insights', id, null, input);
  return d.prepare('SELECT * FROM insights WHERE id = ?').get(id) as MemoryInsight;
}

// ---- Write Journal ----

function journalWrite(d: Database.Database, operation: string, tableName: string, recordId: string, cloudId: string | null, payload: any): void {
  d.prepare(`
    INSERT INTO write_journal (timestamp, operation, table_name, record_id, cloud_id, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(now(), operation, tableName, recordId, cloudId, JSON.stringify(payload));
}

export function getJournalPending(): WriteJournalEntry[] {
  return getDb().prepare('SELECT * FROM write_journal WHERE replayed = 0 ORDER BY seq').all() as WriteJournalEntry[];
}

export function markJournalReplayed(seq: number): void {
  getDb().prepare('UPDATE write_journal SET replayed = 1 WHERE seq = ?').run(seq);
}

// ---- Stats ----

export function getStats(): { entities: number; facts: number; relationships: number; insights: number; embeddings: number; journal_pending: number } {
  const d = getDb();
  const ALLOWED_TABLES = ['entities', 'facts', 'relationships', 'insights', 'embeddings'] as const;
  const count = (table: typeof ALLOWED_TABLES[number]) => {
    if (!ALLOWED_TABLES.includes(table)) throw new Error('Invalid table name');
    return (d.prepare(`SELECT COUNT(*) as c FROM ${table}`).get() as { c: number }).c;
  };
  const journalPending = (d.prepare('SELECT COUNT(*) as c FROM write_journal WHERE replayed = 0').get() as { c: number }).c;

  return {
    entities: count('entities'),
    facts: count('facts'),
    relationships: count('relationships'),
    insights: count('insights'),
    embeddings: count('embeddings'),
    journal_pending: journalPending,
  };
}
