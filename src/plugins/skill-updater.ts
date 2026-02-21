/**
 * Skill Auto-Update — periodically checks cloud for newer versions of installed skills.
 * Deploys updates through existing plugin manager pipeline.
 */

import { PluginManager, DeployOptions } from './manager';
import { PluginManifest } from './manifest';
import { logAudit } from './audit';
import crypto from 'crypto';

interface SkillUpdateInfo {
  skillId: string;
  name: string;
  currentVersion: string;
  latestVersion: string;
  manifest: PluginManifest;
  code: string;
  codeHash: string;
}

interface CloudSkillCheck {
  name: string;
  version: string;
}

interface CloudUpdateResponse {
  updates: Array<{
    name: string;
    version: string;
    manifest: PluginManifest;
    code: string;
    codeHash: string;
    skillId: string;
  }>;
}

const CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export class SkillUpdater {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private pluginManager: PluginManager,
    private apiKey: string,
    private nodeId: string,
    private baseUrl = 'https://www.mybuhdi.com'
  ) {}

  start(): void {
    if (this.timer) return;
    // Initial check after 60s, then every 30 min
    setTimeout(() => {
      this.checkSkillUpdates().catch(err => {
        console.warn('[skill-updater] Initial check failed:', err.message);
      });
    }, 60_000);

    this.timer = setInterval(() => {
      this.checkSkillUpdates().catch(err => {
        console.warn('[skill-updater] Check failed:', err.message);
      });
    }, CHECK_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async checkSkillUpdates(): Promise<SkillUpdateInfo[]> {
    const plugins = this.pluginManager.listPlugins();
    if (plugins.length === 0) return [];

    // Build list of installed skills with versions
    const installed: CloudSkillCheck[] = plugins.map(p => ({
      name: p.name,
      version: p.version,
    }));

    try {
      const res = await fetch(`${this.baseUrl}/api/node/${encodeURIComponent(this.nodeId)}/skill-updates`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-node-key': this.apiKey,
        },
        body: JSON.stringify({ installed }),
      });

      if (!res.ok) {
        console.warn(`[skill-updater] Cloud returned ${res.status}`);
        return [];
      }

      const data = await res.json() as CloudUpdateResponse;
      const updates: SkillUpdateInfo[] = [];

      for (const update of data.updates ?? []) {
        const current = plugins.find(p => p.name === update.name);
        if (!current) continue;

        console.log(`[skill-updater] Updating ${update.name}: ${current.version} → ${update.version}`);

        // Verify code hash locally before deploying — prevent tampered updates
        const localHash = crypto.createHash('sha256').update(update.code).digest('hex');
        if (localHash !== update.codeHash) {
          console.error(`[skill-updater] Hash mismatch for ${update.name}: expected ${update.codeHash}, got ${localHash}`);
          logAudit({
            action: 'error',
            toolId: update.name,
            version: update.version,
            initiatedBy: 'system',
            reason: `Code hash mismatch — possible tampering (expected ${update.codeHash}, got ${localHash})`,
          });
          continue;
        }

        const deployOpts: DeployOptions = {
          codeHash: update.codeHash,
          nonce: Date.now().toString(),
        };

        try {
          await this.pluginManager.updatePlugin(
            update.name,
            update.manifest,
            update.code,
            deployOpts
          );

          logAudit({
            action: 'update',
            toolId: update.name,
            version: update.version,
            initiatedBy: 'system',
            reason: `Auto-update from skill library (${current.version} → ${update.version})`,
          });

          updates.push({
            skillId: update.skillId,
            name: update.name,
            currentVersion: current.version,
            latestVersion: update.version,
            manifest: update.manifest,
            code: update.code,
            codeHash: update.codeHash,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[skill-updater] Failed to update ${update.name}:`, msg);
          logAudit({
            action: 'error',
            toolId: update.name,
            version: update.version,
            initiatedBy: 'system',
            reason: `Auto-update failed: ${msg}`,
          });
        }
      }

      return updates;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[skill-updater] Network error:', msg);
      return [];
    }
  }
}
