/**
 * Plugin Manager — install, start, stop, update, uninstall plugins
 */

import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import os from 'os';
import { PluginManifest, PluginInfo, validateManifest } from './manifest';
import { PluginSandbox, SandboxOptions, detectPermissionChanges } from './sandbox';
import { logAudit, initAudit } from './audit';
import { schedulePlugin, unschedulePlugin } from './scheduler';
import { TrustLevel, shouldAutoApprove } from './trust';
import { verifyDeploySignature, computeCodeHash } from './signing';
import { deletePluginVault } from './plugin-vault';
import { loadConfig } from '../config';
import { registerDashboardPlugin, unregisterDashboardPlugin } from '../dashboard';

const PLUGINS_DIR = path.join(os.homedir(), '.buhdi-node', 'plugins');
const MAX_PLUGINS = 10;
const MAX_TOTAL_DISK_MB = 500;
const MAX_VERSIONS_PER_PLUGIN = 5;

export interface DeployOptions {
  signature?: string;
  nonce?: string;
  codeHash?: string;
  skipSignatureCheck?: boolean;  // only for local dev/testing
}

export interface DeployResult {
  status: 'installed' | 'pending' | 'error';
  message?: string;
}

export class PluginManager {
  private plugins = new Map<string, PluginInfo>();
  private pendingPlugins = new Map<string, { manifest: PluginManifest; codeBundle: string; deployOpts?: DeployOptions }>();
  private sandboxes = new Map<string, PluginSandbox>();
  private apiKey?: string;
  private nodeId?: string;

  constructor(opts?: { apiKey?: string; nodeId?: string }) {
    this.apiKey = opts?.apiKey;
    this.nodeId = opts?.nodeId;
    initAudit({ nodeId: this.nodeId, apiKey: this.apiKey });
  }

  getTrustLevel(): TrustLevel {
    const config = loadConfig();
    return (config.trustLevel as TrustLevel) || TrustLevel.APPROVE_NEW;
  }

  async init(): Promise<void> {
    await fs.mkdir(PLUGINS_DIR, { recursive: true });
    // Load existing plugins from disk
    try {
      const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'audit.log') continue;
        const manifestPath = path.join(PLUGINS_DIR, entry.name, 'manifest.json');
        try {
          const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
          const result = validateManifest(raw);
          if (result.valid) {
            this.plugins.set(entry.name, {
              name: entry.name,
              version: result.manifest.version,
              status: 'installed',
              manifest: result.manifest,
              installedAt: new Date().toISOString(),
            });
            if (result.manifest.type === 'dashboard') {
              const assetsDir = path.join(PLUGINS_DIR, entry.name, 'assets');
              registerDashboardPlugin({
                name: entry.name,
                assetsDir,
                description: result.manifest.description,
                version: result.manifest.version,
              });
            }
          }
        } catch { /* skip invalid */ }
      }
    } catch { /* no plugins dir yet */ }
  }

  async installPlugin(manifest: PluginManifest, codeBundle: string, deployOpts?: DeployOptions): Promise<DeployResult> {
    // Validate manifest
    const result = validateManifest(manifest);
    if (!result.valid) {
      throw new Error(`Invalid manifest: ${result.errors.join(', ')}`);
    }
    const validManifest = result.manifest;

    // ---- Signature verification (SECURITY CRITICAL) ----
    // CRITICAL: Signature or hash verification is REQUIRED unless explicitly skipped for local dev
    if (deployOpts?.signature && deployOpts?.nonce) {
      const valid = verifyDeploySignature(codeBundle, deployOpts.signature, deployOpts.nonce);
      if (!valid) {
        logAudit({
          action: 'error',
          toolId: validManifest.name,
          version: validManifest.version,
          initiatedBy: 'cloud',
          reason: 'Code signature verification FAILED — deploy rejected',
        });
        throw new Error('Code signature verification failed — deploy rejected');
      }
    } else if (deployOpts?.codeHash && deployOpts?.nonce) {
      // Verify hash even without signature
      const computed = computeCodeHash(codeBundle, deployOpts.nonce);
      if (computed !== deployOpts.codeHash) {
        logAudit({
          action: 'error',
          toolId: validManifest.name,
          version: validManifest.version,
          initiatedBy: 'cloud',
          reason: 'Code hash mismatch — deploy rejected',
        });
        throw new Error('Code hash mismatch — deploy rejected');
      }
    } else if (!deployOpts?.skipSignatureCheck) {
      // No signature, no hash, no skip flag — REJECT
      logAudit({
        action: 'error',
        toolId: validManifest.name,
        version: validManifest.version,
        initiatedBy: 'cloud',
        reason: 'Deploy rejected: no signature or code hash provided',
      });
      throw new Error('Deploy rejected: code must be signed or include a verified hash');
    }

    // Check limits
    if (this.plugins.size >= MAX_PLUGINS && !this.plugins.has(validManifest.name)) {
      throw new Error(`Plugin limit reached (${MAX_PLUGINS})`);
    }

    const totalDisk = await this.getTotalDiskUsageMb();
    if (totalDisk > MAX_TOTAL_DISK_MB) {
      throw new Error(`Total plugin disk usage exceeds ${MAX_TOTAL_DISK_MB}MB`);
    }

    // ---- Trust level check ----
    const trustLevel = this.getTrustLevel();
    const isNewPlugin = !this.plugins.has(validManifest.name);
    const existingPlugin = this.plugins.get(validManifest.name);
    const hasPermissionChange = existingPlugin
      ? detectPermissionChanges(existingPlugin.manifest, validManifest).hasEscalation
      : false;

    const autoApproved = shouldAutoApprove(trustLevel, isNewPlugin, hasPermissionChange);

    if (!autoApproved) {
      // Save as pending — don't write to plugin dir yet
      this.pendingPlugins.set(validManifest.name, { manifest: validManifest, codeBundle, deployOpts });
      logAudit({
        action: 'deploy',
        toolId: validManifest.name,
        version: validManifest.version,
        initiatedBy: 'cloud',
        reason: `Pending approval (trust: ${trustLevel}, new: ${isNewPlugin}, permChange: ${hasPermissionChange})`,
      });
      return { status: 'pending', message: `Awaiting approval (trust level: ${trustLevel})` };
    }

    // ---- Auto-approved: write to disk ----
    await this.writePluginToDisk(validManifest, codeBundle);

    logAudit({
      action: 'deploy',
      toolId: validManifest.name,
      version: validManifest.version,
      initiatedBy: 'cloud',
    });

    return { status: 'installed' };
  }

  private async writePluginToDisk(manifest: PluginManifest, codeBundle: string): Promise<void> {
    const pluginDir = path.join(PLUGINS_DIR, manifest.name);
    const dataDir = path.join(pluginDir, 'data');

    await fs.mkdir(pluginDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });

    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await fs.writeFile(path.join(pluginDir, manifest.entry), codeBundle);

    this.plugins.set(manifest.name, {
      name: manifest.name,
      version: manifest.version,
      status: 'installed',
      manifest,
      installedAt: new Date().toISOString(),
    });

    // Register dashboard plugin for static file serving
    if (manifest.type === 'dashboard') {
      const assetsDir = path.join(pluginDir, 'assets');
      fsSync.mkdirSync(assetsDir, { recursive: true });
      registerDashboardPlugin({
        name: manifest.name,
        assetsDir,
        description: manifest.description,
        version: manifest.version,
      });
    }
  }

  // ---- Pending plugin approval/rejection ----

  async approvePlugin(name: string): Promise<void> {
    const pending = this.pendingPlugins.get(name);
    if (!pending) throw new Error(`No pending plugin: ${name}`);

    await this.writePluginToDisk(pending.manifest, pending.codeBundle);
    this.pendingPlugins.delete(name);

    logAudit({
      action: 'deploy',
      toolId: name,
      version: pending.manifest.version,
      initiatedBy: 'user',
      reason: 'Approved by user',
    });

    // Auto-start after approval
    try {
      await this.startPlugin(name);
    } catch (err: any) {
      console.error(`Plugin ${name} approved but failed to start:`, err.message);
    }
  }

  async rejectPlugin(name: string): Promise<void> {
    const pending = this.pendingPlugins.get(name);
    if (!pending) throw new Error(`No pending plugin: ${name}`);

    this.pendingPlugins.delete(name);

    logAudit({
      action: 'uninstall',
      toolId: name,
      version: pending.manifest.version,
      initiatedBy: 'user',
      reason: 'Rejected by user',
    });
  }

  listPendingPlugins(): Array<{ name: string; version: string }> {
    return Array.from(this.pendingPlugins.entries()).map(([name, p]) => ({
      name,
      version: p.manifest.version,
    }));
  }

  async startPlugin(name: string): Promise<void> {
    const info = this.plugins.get(name);
    if (!info) throw new Error(`Plugin not found: ${name}`);
    if (info.status === 'running') return;

    const pluginDir = path.join(PLUGINS_DIR, name);
    const dataDir = path.join(pluginDir, 'data');
    const code = await fs.readFile(path.join(pluginDir, info.manifest.entry), 'utf8');

    const sandbox = new PluginSandbox({
      manifest: info.manifest,
      dataDir,
      code,
      apiKey: this.apiKey,
      nodeId: this.nodeId,
    });

    try {
      await sandbox.start();
      this.sandboxes.set(name, sandbox);
      info.status = 'running';
      info.error = undefined;

      // Post-deploy health check: verify plugin survives 5 seconds
      await this.postDeployHealthCheck(name, sandbox);

      // Set up scheduler if manifest has schedule
      if (info.manifest.schedule) {
        schedulePlugin(name, info.manifest.schedule, () => {
          this.restartPlugin(name).catch(err => {
            console.error(`Scheduled restart of ${name} failed:`, err.message);
          });
        });
      }

      logAudit({ action: 'start', toolId: name, version: info.version, initiatedBy: 'system' });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      info.status = 'error';
      info.error = errMsg;
      sandbox.dispose();
      throw err;
    }
  }

  /**
   * Post-deploy health check — verify plugin doesn't crash within 5 seconds.
   * If it crashes, auto-rollback and report failure.
   */
  private async postDeployHealthCheck(name: string, sandbox: PluginSandbox): Promise<void> {
    return new Promise<void>((resolve) => {
      const healthTimeout = setTimeout(() => {
        // Plugin survived 5 seconds — report success
        this.reportDeployResult(name, true).catch(() => {});
        resolve();
      }, 5000);

      // Listen for early crash
      sandbox.onExit(() => {
        clearTimeout(healthTimeout);
        const info = this.plugins.get(name);
        if (info) {
          info.status = 'error';
          info.error = 'Plugin crashed during health check (within 5s of start)';
          logAudit({
            action: 'error',
            toolId: name,
            version: info.version,
            initiatedBy: 'system',
            reason: 'Post-deploy health check failed — plugin crashed',
          });
        }
        this.sandboxes.delete(name);
        this.reportDeployResult(name, false, 'Plugin crashed within 5 seconds of start').catch(() => {});
        // Attempt auto-rollback to previous version
        this.autoRollback(name).catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`Auto-rollback of ${name} failed:`, msg);
        });
        resolve();
      });
    });
  }

  /**
   * Auto-rollback to the most recent working version of a plugin.
   */
  private async autoRollback(name: string): Promise<void> {
    const pluginDir = path.join(PLUGINS_DIR, name);
    const versionsDir = path.join(pluginDir, 'versions');
    try {
      const versions = (await fs.readdir(versionsDir)).sort().reverse();
      for (const ver of versions) {
        const oldManifestPath = path.join(versionsDir, ver, 'manifest.json');
        try {
          const oldManifest = JSON.parse(await fs.readFile(oldManifestPath, 'utf8')) as PluginManifest;
          const oldCodePath = path.join(versionsDir, ver, oldManifest.entry);
          const oldCode = await fs.readFile(oldCodePath, 'utf8');

          await this.writePluginToDisk(oldManifest, oldCode);
          logAudit({
            action: 'rollback',
            toolId: name,
            version: ver,
            initiatedBy: 'system',
            reason: 'Auto-rollback after health check failure',
          });
          return;
        } catch { /* try next version */ }
      }
    } catch { /* no versions to rollback to */ }
  }

  /**
   * Report deploy result back to cloud API.
   */
  async reportDeployResult(toolName: string, success: boolean, error?: string): Promise<void> {
    if (!this.apiKey || !this.nodeId) return;
    const baseUrl = 'https://www.mybuhdi.com';
    try {
      await fetch(`${baseUrl}/api/node/${encodeURIComponent(this.nodeId)}/tools/${encodeURIComponent(toolName)}/deploy-result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-node-key': this.apiKey,
        },
        body: JSON.stringify({ success, error }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Failed to report deploy result for ${toolName}:`, msg);
    }
  }

  async stopPlugin(name: string): Promise<void> {
    const info = this.plugins.get(name);
    if (!info) throw new Error(`Plugin not found: ${name}`);

    const sandbox = this.sandboxes.get(name);
    if (sandbox) {
      sandbox.dispose();
      this.sandboxes.delete(name);
    }

    unschedulePlugin(name);
    info.status = 'installed';
    info.error = undefined;

    logAudit({ action: 'stop', toolId: name, version: info.version, initiatedBy: 'system' });
  }

  async uninstallPlugin(name: string): Promise<void> {
    // Stop first if running
    if (this.sandboxes.has(name)) {
      await this.stopPlugin(name);
    }

    const info = this.plugins.get(name);
    const version = info?.version || 'unknown';

    // Unregister from dashboard if applicable
    if (info?.manifest.type === 'dashboard') {
      unregisterDashboardPlugin(name);
    }

    // Clean up encrypted vault before removing plugin directory
    await deletePluginVault(name);

    const pluginDir = path.join(PLUGINS_DIR, name);
    try {
      await fs.rm(pluginDir, { recursive: true, force: true });
    } catch { /* may not exist */ }

    this.plugins.delete(name);

    logAudit({ action: 'uninstall', toolId: name, version, initiatedBy: 'system' });
  }

  async updatePlugin(name: string, manifest: PluginManifest, codeBundle: string, deployOpts?: DeployOptions): Promise<void> {
    const info = this.plugins.get(name);
    if (!info) {
      // Fresh install
      await this.installPlugin(manifest, codeBundle, deployOpts);
      return;
    }

    // R2-I1: Defense-in-depth — verify signature on updates when deployOpts provided
    if (deployOpts?.signature && deployOpts?.nonce) {
      const valid = verifyDeploySignature(codeBundle, deployOpts.signature, deployOpts.nonce);
      if (!valid) {
        logAudit({
          action: 'error',
          toolId: name,
          version: manifest.version,
          initiatedBy: 'cloud',
          reason: 'Update signature verification FAILED — rejected',
        });
        throw new Error('Update signature verification failed — rejected');
      }
    } else if (deployOpts?.codeHash && deployOpts?.nonce) {
      const computed = computeCodeHash(codeBundle, deployOpts.nonce);
      if (computed !== deployOpts.codeHash) {
        logAudit({
          action: 'error',
          toolId: name,
          version: manifest.version,
          initiatedBy: 'cloud',
          reason: 'Update code hash mismatch — rejected',
        });
        throw new Error('Update code hash mismatch — rejected');
      }
    } else if (!deployOpts?.skipSignatureCheck) {
      // W-E8: Reject updates without signature/hash (same policy as installPlugin)
      logAudit({
        action: 'error',
        toolId: name,
        version: manifest.version,
        initiatedBy: 'cloud',
        reason: 'Update rejected: no signature or code hash provided',
      });
      throw new Error('Update rejected: code must be signed or include a verified hash');
    }

    const oldVersion = info.version;
    const pluginDir = path.join(PLUGINS_DIR, name);
    const versionsDir = path.join(pluginDir, 'versions');

    // Save current version to versions/
    await fs.mkdir(path.join(versionsDir, oldVersion), { recursive: true });
    try {
      await fs.copyFile(
        path.join(pluginDir, 'manifest.json'),
        path.join(versionsDir, oldVersion, 'manifest.json')
      );
      await fs.copyFile(
        path.join(pluginDir, info.manifest.entry),
        path.join(versionsDir, oldVersion, info.manifest.entry)
      );
    } catch { /* old files may not exist */ }

    // Clean old versions (keep max 5)
    await this.pruneVersions(name);

    // Stop if running
    const wasRunning = info.status === 'running';
    if (wasRunning) {
      await this.stopPlugin(name);
    }

    // Install new version
    const result = validateManifest(manifest);
    if (!result.valid) throw new Error(`Invalid manifest: ${result.errors.join(', ')}`);

    await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(result.manifest, null, 2));
    await fs.writeFile(path.join(pluginDir, result.manifest.entry), codeBundle);

    info.manifest = result.manifest;
    info.version = result.manifest.version;

    logAudit({ action: 'update', toolId: name, version: result.manifest.version, initiatedBy: 'cloud' });

    // Restart if was running
    if (wasRunning) {
      try {
        await this.startPlugin(name);
      } catch (err: any) {
        // Rollback to previous version
        console.error(`Plugin ${name} update failed, rolling back:`, err.message);
        try {
          const oldManifestPath = path.join(versionsDir, oldVersion, 'manifest.json');
          const oldCodePath = path.join(versionsDir, oldVersion, info.manifest.entry);
          const oldManifest = JSON.parse(await fs.readFile(oldManifestPath, 'utf8'));
          const oldCode = await fs.readFile(oldCodePath, 'utf8');

          await fs.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(oldManifest, null, 2));
          await fs.writeFile(path.join(pluginDir, oldManifest.entry), oldCode);

          info.manifest = oldManifest;
          info.version = oldVersion;

          await this.startPlugin(name);
          logAudit({ action: 'rollback', toolId: name, version: oldVersion, initiatedBy: 'system', reason: err.message });
        } catch (rollbackErr: any) {
          info.status = 'error';
          info.error = `Update failed and rollback failed: ${rollbackErr.message}`;
          logAudit({ action: 'error', toolId: name, version: oldVersion, initiatedBy: 'system', reason: info.error });
        }
      }
    }
  }

  listPlugins(): PluginInfo[] {
    return Array.from(this.plugins.values());
  }

  getPlugin(name: string): PluginInfo | undefined {
    return this.plugins.get(name);
  }

  getPluginStatuses(): Array<{ name: string; version: string; status: string }> {
    return this.listPlugins().map(p => ({ name: p.name, version: p.version, status: p.status }));
  }

  async stopAll(): Promise<void> {
    for (const name of this.sandboxes.keys()) {
      await this.stopPlugin(name).catch(() => {});
    }
  }

  // ---- Private helpers ----

  private async restartPlugin(name: string): Promise<void> {
    await this.stopPlugin(name);
    await this.startPlugin(name);
  }

  private async pruneVersions(name: string): Promise<void> {
    const versionsDir = path.join(PLUGINS_DIR, name, 'versions');
    try {
      const versions = (await fs.readdir(versionsDir)).sort();
      while (versions.length > MAX_VERSIONS_PER_PLUGIN) {
        const oldest = versions.shift()!;
        await fs.rm(path.join(versionsDir, oldest), { recursive: true, force: true });
      }
    } catch { /* no versions dir */ }
  }

  private async getTotalDiskUsageMb(): Promise<number> {
    try {
      let total = 0;
      const entries = await fs.readdir(PLUGINS_DIR, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        total += await this.getDirSizeBytes(path.join(PLUGINS_DIR, entry.name));
      }
      return total / (1024 * 1024);
    } catch {
      return 0;
    }
  }

  private async getDirSizeBytes(dir: string): Promise<number> {
    let size = 0;
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          size += await this.getDirSizeBytes(full);
        } else {
          const stat = await fs.stat(full);
          size += stat.size;
        }
      }
    } catch { /* skip */ }
    return size;
  }
}
