/**
 * Plugin audit logger — JSON lines to ~/.buhdi-node/plugins/audit.log
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const AUDIT_DIR = path.join(os.homedir(), '.buhdi-node', 'plugins');
const AUDIT_FILE = path.join(AUDIT_DIR, 'audit.log');

export type AuditAction = 'deploy' | 'start' | 'stop' | 'update' | 'rollback' | 'uninstall' | 'error';

export interface AuditEntry {
  action: AuditAction;
  toolId: string;
  version: string;
  initiatedBy: string;
  reason?: string;
  timestamp: string;
  details?: Record<string, any>;
}

let nodeId: string | null = null;
let apiKey: string | null = null;

export function initAudit(opts: { nodeId?: string; apiKey?: string } = {}): void {
  nodeId = opts.nodeId || null;
  apiKey = opts.apiKey || null;
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
}

export function logAudit(entry: Omit<AuditEntry, 'timestamp'>): void {
  const full: AuditEntry = { ...entry, timestamp: new Date().toISOString() };
  try {
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(full) + '\n');
  } catch (err: any) {
    console.error('Audit log write failed:', err.message);
  }

  // Fire-and-forget sync to cloud
  if (nodeId && apiKey && entry.toolId) {
    syncAuditEntry(full).catch(() => {});
  }
}

async function syncAuditEntry(entry: AuditEntry): Promise<void> {
  try {
    await fetch(`https://www.mybuhdi.com/api/node/${nodeId}/tools/${entry.toolId}/logs`, {
      method: 'POST',
      headers: { 'x-node-key': apiKey!, 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    });
  } catch { /* fire and forget */ }
}
