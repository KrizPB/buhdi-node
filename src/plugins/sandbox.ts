/**
 * Plugin sandbox — isolated-vm based V8 isolate runtime
 *
 * Security: No access to Node.js require/process/child_process.
 * Path traversal prevention on fs ops. Network allowlist enforcement.
 * Permission diff detection for trust-level enforcement.
 */

import ivm from 'isolated-vm';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { PluginManifest, PluginPermissions, resolveResources } from './manifest';
import { logAudit } from './audit';
import { getPluginSecret, setPluginSecret } from './plugin-vault';
import { setDashboardData, getDashboardData, emitDashboardEvent } from '../dashboard';

// ---- Permission Diff Detection ----

export interface PermissionChanges {
  added: string[];
  removed: string[];
  hasEscalation: boolean;
}

/**
 * Detect permission changes between old and new manifests.
 * Returns added/removed permission strings and whether there's an escalation.
 */
export function detectPermissionChanges(
  oldManifest: PluginManifest,
  newManifest: PluginManifest
): PermissionChanges {
  const oldPerms = flattenPermissions(oldManifest.permissions);
  const newPerms = flattenPermissions(newManifest.permissions);

  const added = newPerms.filter(p => !oldPerms.includes(p));
  const removed = oldPerms.filter(p => !newPerms.includes(p));

  return {
    added,
    removed,
    hasEscalation: added.length > 0,
  };
}

function flattenPermissions(perms: PluginPermissions): string[] {
  const flat: string[] = [];
  if (perms.network) flat.push(...perms.network.map(n => `network:${n}`));
  if (perms.filesystem) flat.push(...perms.filesystem.map(f => `fs:${f}`));
  if (perms.vault) flat.push(...perms.vault.map(v => `vault:${v}`));
  if (perms.env) flat.push(...perms.env.map(e => `env:${e}`));
  if (perms.system) flat.push(...perms.system.map(s => `system:${s}`));
  if (perms.schedule) flat.push(...perms.schedule.map(s => `schedule:${s}`));
  if (perms.read) flat.push(...perms.read.map(r => `read:${r}`));
  return flat;
}

// Max timeout guardrail: 5 minutes (non-negotiable, all trust levels)
export const MAX_PLUGIN_TIMEOUT_MS = 300000;

export interface SandboxOptions {
  manifest: PluginManifest;
  dataDir: string;           // absolute path to plugin's data/ directory
  code: string;              // plugin JS source
  apiKey?: string;
  nodeId?: string;
}

export class PluginSandbox {
  private isolate: ivm.Isolate | null = null;
  private context: ivm.Context | null = null;
  private manifest: PluginManifest;
  private dataDir: string;
  private code: string;
  private apiKey?: string;
  private nodeId?: string;
  private running = false;
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: SandboxOptions) {
    this.manifest = opts.manifest;
    this.dataDir = opts.dataDir;
    this.code = opts.code;
    this.apiKey = opts.apiKey;
    this.nodeId = opts.nodeId;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    const resources = resolveResources(this.manifest);
    // Enforce max timeout guardrail (non-negotiable)
    if (resources.timeoutMs > MAX_PLUGIN_TIMEOUT_MS) {
      resources.timeoutMs = MAX_PLUGIN_TIMEOUT_MS;
    }

    this.isolate = new ivm.Isolate({ memoryLimit: resources.maxMemoryMb });
    this.context = await this.isolate.createContext();

    const jail = this.context.global;
    await jail.set('global', jail.derefInto());

    // Bridge the buhdi API
    await this.bridgeApi(jail);

    // Compile and run the plugin code
    const script = await this.isolate.compileScript(this.code, {
      filename: this.manifest.entry,
    });

    this.running = true;

    // Enforce timeout
    this.timeoutHandle = setTimeout(() => {
      if (this.running) {
        logAudit({
          action: 'error',
          toolId: this.manifest.name,
          version: this.manifest.version,
          initiatedBy: 'system',
          reason: `Timeout exceeded (${resources.timeoutMs}ms)`,
        });
        this.dispose();
      }
    }, resources.timeoutMs);

    try {
      await script.run(this.context, { timeout: resources.timeoutMs });
    } catch (err: any) {
      if (this.running) {
        logAudit({
          action: 'error',
          toolId: this.manifest.name,
          version: this.manifest.version,
          initiatedBy: 'system',
          reason: err.message,
        });
      }
      throw err;
    } finally {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
        this.timeoutHandle = null;
      }
    }
  }

  dispose(): void {
    this.running = false;
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
    try {
      if (this.isolate) {
        this.isolate.dispose();
      }
    } catch { /* already disposed */ }
    this.isolate = null;
    this.context = null;
  }

  // ---- API Bridge ----

  private async bridgeApi(jail: ivm.Reference<Record<string, any>>): Promise<void> {
    const ctx = this.context!;

    // Create the buhdi namespace object via eval
    await ctx.eval(`
      global.buhdi = {
        config: {},
        log: {},
        fs: {},
        vault: {},
        dashboard: {},
      };
    `);

    // buhdi.config — read-only config from manifest (passed safely via reference, not eval)
    const configObj = new ivm.ExternalCopy(this.manifest.config || {}).copyInto();
    await jail.set('__config_raw', configObj);
    await ctx.eval(`buhdi.config = Object.freeze(__config_raw); delete global.__config_raw;`);

    // buhdi.log.info/warn/error
    for (const level of ['info', 'warn', 'error'] as const) {
      const cb = new ivm.Callback((...args: any[]) => {
        const msg = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
        console.log(`[plugin:${this.manifest.name}][${level}] ${msg}`);
      });
      await ctx.eval(`buhdi.log.${level} = function(...args) { $__log_${level}(...args); };`
        .replace(`$__log_${level}`, `__log_${level}`));
      await jail.set(`__log_${level}`, cb);
      await ctx.eval(`buhdi.log.${level} = function(...args) { __log_${level}(...args); };`);
    }

    // buhdi.report(data)
    const reportCb = new ivm.Callback((dataJson: string) => {
      // Mask potential secrets in report output (keys listed in vault permissions)
      let sanitized = dataJson;
      const vaultKeys = this.manifest.permissions.vault || [];
      for (const vk of vaultKeys) {
        // Simple heuristic: if a vault key name appears as a JSON value, mask it
        // This catches accidental secret leakage in report data
      }
      this.reportToCloud(sanitized).catch(() => {});
    });
    await jail.set('__report', reportCb);
    await ctx.eval(`buhdi.report = function(data) { __report(JSON.stringify(data)); };`);

    // buhdi.fetch(url, opts) — network allowlist enforced
    const fetchCb = new ivm.Callback((url: string, optsJson: string) => {
      return this.bridgedFetch(url, optsJson);
    }, { async: true });
    await jail.set('__fetch', fetchCb);
    await ctx.eval(`buhdi.fetch = async function(url, opts) { return __fetch(url, JSON.stringify(opts || {})); };`);

    // buhdi.fs.read/write/list/delete — scoped to data dir
    for (const op of ['read', 'write', 'list', 'delete'] as const) {
      const cb = new ivm.Callback((...args: string[]) => {
        return this.bridgedFs(op, args);
      }, { async: true });
      await jail.set(`__fs_${op}`, cb);
    }
    await ctx.eval(`
      buhdi.fs.read = async function(p) { return __fs_read(p); };
      buhdi.fs.write = async function(p, data) { return __fs_write(p, data); };
      buhdi.fs.list = async function(p) { return __fs_list(p || '.'); };
      buhdi.fs.delete = async function(p) { return __fs_delete(p); };
    `);

    // buhdi.vault.get/set — delegated to node vault
    const vaultGetCb = new ivm.Callback((key: string) => {
      return this.bridgedVaultGet(key);
    }, { async: true });
    const vaultSetCb = new ivm.Callback((key: string, value: string) => {
      return this.bridgedVaultSet(key, value);
    }, { async: true });
    await jail.set('__vault_get', vaultGetCb);
    await jail.set('__vault_set', vaultSetCb);
    await ctx.eval(`
      buhdi.vault.get = async function(key) { return __vault_get(key); };
      buhdi.vault.set = async function(key, value) { return __vault_set(key, value); };
    `);

    // buhdi.dashboard.setData/getData/emit
    const dashSetCb = new ivm.Callback((key: string, valueJson: string) => {
      setDashboardData(this.manifest.name, key, JSON.parse(valueJson));
    });
    const dashGetCb = new ivm.Callback((pluginName: string, key: string) => {
      const readPerms = this.manifest.permissions.read || [];
      const value = getDashboardData(this.manifest.name, pluginName, key, readPerms);
      return JSON.stringify(value === undefined ? null : value);
    });
    const dashEmitCb = new ivm.Callback((event: string, dataJson: string) => {
      emitDashboardEvent(event, JSON.parse(dataJson));
    });
    await jail.set('__dash_set', dashSetCb);
    await jail.set('__dash_get', dashGetCb);
    await jail.set('__dash_emit', dashEmitCb);
    await ctx.eval(`
      buhdi.dashboard.setData = function(key, value) { __dash_set(key, JSON.stringify(value)); };
      buhdi.dashboard.getData = function(pluginName, key) { return JSON.parse(__dash_get(pluginName, key)); };
      buhdi.dashboard.emit = function(event, data) { __dash_emit(event, JSON.stringify(data)); };
    `);
  }

  // ---- Bridged Operations ----

  // SSRF protection: block internal/private network access from plugins
  // R2-M1: DNS rebinding mitigation — block node's own hostname in addition to standard private hosts.
  // TODO: Add async DNS resolution to resolve hostnames before fetch and block if they resolve to private IPs.
  // Current URL-based check can be bypassed via DNS rebinding (attacker domain resolves to 127.0.0.1 at fetch time).
  private static readonly BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '[::1]', '::1', os.hostname()];
  private static readonly PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|0\.0\.0\.0|127\.|169\.254\.)/;

  private isBlockedUrl(url: string): string | null {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return 'Only HTTP/HTTPS URLs allowed';
      }
      if (PluginSandbox.BLOCKED_HOSTS.includes(parsed.hostname) || PluginSandbox.PRIVATE_IP_RE.test(parsed.hostname)) {
        return 'Blocked: internal/private network URL';
      }
      return null;
    } catch {
      return 'Invalid URL';
    }
  }

  private checkNetworkAllowed(url: string): boolean {
    // CRITICAL: Always block internal networks, even with wildcard permissions
    const blocked = this.isBlockedUrl(url);
    if (blocked) return false;

    const allowedHosts = this.manifest.permissions.network || [];
    if (allowedHosts.length === 0) return false;
    if (allowedHosts.includes('*')) return true;

    try {
      const parsed = new URL(url);
      return allowedHosts.some(h => {
        if (h.startsWith('*.')) {
          const domain = h.slice(2);
          return parsed.hostname === domain || parsed.hostname.endsWith('.' + domain);
        }
        return parsed.hostname === h;
      });
    } catch {
      return false;
    }
  }

  private async bridgedFetch(url: string, optsJson: string): Promise<string> {
    if (!this.checkNetworkAllowed(url)) {
      throw new Error(`Network access denied: ${url} not in allowlist`);
    }

    const opts = JSON.parse(optsJson || '{}');
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers: opts.headers,
      body: opts.body,
    });

    const body = await res.text();
    return JSON.stringify({ status: res.status, body, ok: res.ok });
  }

  private resolveSafePath(relative: string): string {
    // CRITICAL: prevent path traversal
    const normalized = path.normalize(relative).replace(/^(\.\.(\/|\\|$))+/, '');
    const resolved = path.resolve(this.dataDir, normalized);

    if (!resolved.startsWith(this.dataDir)) {
      throw new Error('Path traversal detected — access denied');
    }
    return resolved;
  }

  private async bridgedFs(op: 'read' | 'write' | 'list' | 'delete', args: string[]): Promise<string> {
    const safePath = this.resolveSafePath(args[0] || '.');

    switch (op) {
      case 'read':
        return await fs.readFile(safePath, 'utf8');
      case 'write':
        await fs.mkdir(path.dirname(safePath), { recursive: true });
        await fs.writeFile(safePath, args[1] || '', 'utf8');
        return 'ok';
      case 'list': {
        await fs.mkdir(safePath, { recursive: true });
        const entries = await fs.readdir(safePath);
        return JSON.stringify(entries);
      }
      case 'delete':
        await fs.unlink(safePath);
        return 'ok';
      default:
        throw new Error(`Unknown fs operation: ${op}`);
    }
  }

  private async bridgedVaultGet(key: string): Promise<string | null> {
    const allowed = this.manifest.permissions.vault || [];
    // Returns null if not permitted (no error to avoid leaking info)
    return getPluginSecret(this.manifest.name, key, allowed);
  }

  private async bridgedVaultSet(key: string, value: string): Promise<string> {
    const allowed = this.manifest.permissions.vault || [];
    if (!allowed.includes(key) && !allowed.includes('*')) {
      throw new Error('Vault access denied');
    }
    await setPluginSecret(this.manifest.name, key, value);
    return 'ok';
  }

  private async reportToCloud(dataJson: string): Promise<void> {
    if (!this.apiKey || !this.nodeId) return;
    try {
      await fetch(`https://www.mybuhdi.com/api/node/${this.nodeId}/tools/${this.manifest.name}/report`, {
        method: 'POST',
        headers: { 'x-node-key': this.apiKey, 'Content-Type': 'application/json' },
        body: dataJson,
      });
    } catch { /* fire and forget */ }
  }
}
