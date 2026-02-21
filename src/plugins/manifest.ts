/**
 * Plugin manifest schema, parser, and validator
 */

export interface PluginPermissions {
  network?: string[];         // allowed hostnames/URLs
  filesystem?: string[];      // scoped paths (always restricted to data/)
  vault?: string[];           // vault key names accessible
  env?: string[];             // env var names accessible
  system?: string[];          // system capabilities (e.g. 'notifications')
  schedule?: string[];        // cron expressions or intervals
  read?: string[];            // cross-plugin data read: ["read:other-plugin-name"]
  resources?: PluginResources;
}

export interface PluginResources {
  maxMemoryMb?: number;       // default 128
  maxCpuPercent?: number;     // default 25
  timeoutMs?: number;         // default 30000
  maxDiskMb?: number;         // default 50
}

export interface PluginManifest {
  name: string;
  version: string;
  runtime: 'isolate';         // only isolate for now
  type?: 'tool' | 'dashboard'; // default 'tool'
  entry: string;              // e.g. "index.js"
  permissions: PluginPermissions;
  resources?: PluginResources;
  schedule?: string;          // cron expression or interval like "every 5m"
  description?: string;
  author?: string;
  config?: Record<string, unknown>;
  codeHash?: string;             // sha256 of code bundle (for verification)
  signature?: string;            // Ed25519 signature (hex)
}

export interface PluginInfo {
  name: string;
  version: string;
  status: 'pending' | 'installed' | 'running' | 'stopped' | 'error';
  manifest: PluginManifest;
  installedAt: string;
  error?: string;
}

const REQUIRED_FIELDS: (keyof PluginManifest)[] = ['name', 'version', 'runtime', 'entry', 'permissions'];

const VALID_PERMISSION_CATEGORIES = ['network', 'filesystem', 'vault', 'env', 'system', 'schedule', 'resources', 'read'];

const NAME_REGEX = /^[a-z0-9][a-z0-9\-_.]{0,63}$/;
const VERSION_REGEX = /^\d+\.\d+\.\d+/;

export const DEFAULT_RESOURCES: Required<PluginResources> = {
  maxMemoryMb: 128,
  maxCpuPercent: 25,
  timeoutMs: 30000,
  maxDiskMb: 50,
};

export function validateManifest(raw: any): { valid: true; manifest: PluginManifest } | { valid: false; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Manifest must be a JSON object'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (raw[field] === undefined || raw[field] === null) {
      errors.push(`Missing required field: ${field}`);
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  if (typeof raw.name !== 'string' || !NAME_REGEX.test(raw.name)) {
    errors.push(`Invalid name: must match ${NAME_REGEX} (lowercase alphanumeric, hyphens, dots, underscores)`);
  }

  if (typeof raw.version !== 'string' || !VERSION_REGEX.test(raw.version)) {
    errors.push('Invalid version: must be semver (e.g. 1.0.0)');
  }

  if (raw.runtime !== 'isolate') {
    errors.push('Invalid runtime: only "isolate" is supported');
  }

  if (raw.type !== undefined && raw.type !== 'tool' && raw.type !== 'dashboard') {
    errors.push('Invalid type: must be "tool" or "dashboard"');
  }

  if (typeof raw.entry !== 'string' || raw.entry.includes('..') || raw.entry.startsWith('/')) {
    errors.push('Invalid entry: must be a relative path without ".."');
  }

  if (typeof raw.permissions !== 'object') {
    errors.push('permissions must be an object');
  } else {
    for (const key of Object.keys(raw.permissions)) {
      if (!VALID_PERMISSION_CATEGORIES.includes(key)) {
        errors.push(`Unknown permission category: ${key}`);
      }
    }
  }

  if (raw.resources) {
    if (typeof raw.resources !== 'object') {
      errors.push('resources must be an object');
    } else {
      const r = raw.resources;
      if (r.maxMemoryMb !== undefined && (typeof r.maxMemoryMb !== 'number' || r.maxMemoryMb < 1 || r.maxMemoryMb > 512)) {
        errors.push('resources.maxMemoryMb must be 1-512');
      }
      if (r.maxCpuPercent !== undefined && (typeof r.maxCpuPercent !== 'number' || r.maxCpuPercent < 1 || r.maxCpuPercent > 100)) {
        errors.push('resources.maxCpuPercent must be 1-100');
      }
      if (r.timeoutMs !== undefined && (typeof r.timeoutMs !== 'number' || r.timeoutMs < 1000 || r.timeoutMs > 300000)) {
        errors.push('resources.timeoutMs must be 1000-300000');
      }
      if (r.maxDiskMb !== undefined && (typeof r.maxDiskMb !== 'number' || r.maxDiskMb < 1 || r.maxDiskMb > 500)) {
        errors.push('resources.maxDiskMb must be 1-500');
      }
    }
  }

  if (errors.length > 0) return { valid: false, errors };

  const manifest: PluginManifest = {
    name: raw.name,
    version: raw.version,
    runtime: raw.runtime,
    type: raw.type || 'tool',
    entry: raw.entry,
    permissions: raw.permissions,
    resources: { ...DEFAULT_RESOURCES, ...raw.resources },
    schedule: raw.schedule,
    description: raw.description,
    author: raw.author,
    config: raw.config,
  };

  return { valid: true, manifest };
}

export function resolveResources(manifest: PluginManifest): Required<PluginResources> {
  return { ...DEFAULT_RESOURCES, ...manifest.resources };
}
