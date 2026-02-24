import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

const CONFIG_DIR = path.join(os.homedir(), '.buhdi-node');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ---- V1 interface (backward compat) ----
export interface BuhdiConfigV1 {
  apiKey?: string;
  nodeId?: string;
}

// ---- V2 interface ----
export interface BuhdiConfig {
  version: 2;
  apiKey_encrypted?: string;   // AES-256-GCM encrypted
  apiKey_salt?: string;        // per-key salt (base64)
  nodeId?: string;
  wsUrl?: string;
  apiUrl?: string;
  logLevel?: string;           // debug | info | warn | error
  healthPort?: number;         // 0 = disabled, default 9847
  trustLevel?: string;           // approve_each | approve_new | peacock
  deployKeyPub?: string;         // cached Ed25519 public key (hex)
  dashboardPort?: number;        // 0 = disabled, default 3847
  dashboardToken?: string;       // auto-generated bearer token for non-local access
  features?: {
    polling?: boolean;
    vault?: boolean;
  };
  llm?: {
    strategy?: string;
    providers?: Array<{
      name: string;
      endpoint: string;
      model: string;
      apiKey?: string;           // NOTE: For local-only use. For production, store in credential vault as 'llm_<name>'
      priority: number;
      capabilities: string[];
      maxContext: number;
      enabled: boolean;
    }>;
    maxLatencyMs?: number;
    retries?: number;
  };
  scheduler?: {
    allowScripts?: boolean;    // Default false — must explicitly enable shell commands
  };
  memory?: {
    enabled?: boolean;
    db_path?: string;
    owner_id?: string;
    embedding?: {
      provider?: string;         // 'ollama' | 'openai-compat' | auto-detect
      endpoint?: string;         // Any local embedding server URL
      model?: string;            // Model name
      dimensions?: number;
      api_key?: string;
    };
    // Legacy compat
    embedding_model?: string;
    ollama_url?: string;
    sync?: {
      enabled: boolean;
      cloud_url: string;
      api_key: string;
      interval_seconds: number;
    };
  };
}

// Legacy compat export
export type { BuhdiConfigV1 as LegacyConfig };

// ---- Machine-derived encryption key ----

function getMachineId(): string {
  // Best-effort machine identifier: hostname + username
  return `${os.hostname()}:${os.userInfo().username}`;
}

function deriveKey(salt: Buffer): Buffer {
  const machineId = getMachineId();
  return crypto.pbkdf2Sync(machineId, salt, 100_000, 32, 'sha256');
}

export function encryptApiKey(plaintext: string): { encrypted: string; salt: string } {
  const salt = crypto.randomBytes(16);
  const key = deriveKey(salt);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(16) + tag(16) + ciphertext → base64
  const blob = Buffer.concat([iv, tag, enc]);
  return { encrypted: blob.toString('base64'), salt: salt.toString('base64') };
}

export function decryptApiKey(encrypted: string, saltB64: string): string {
  const salt = Buffer.from(saltB64, 'base64');
  const key = deriveKey(salt);
  const blob = Buffer.from(encrypted, 'base64');
  const iv = blob.subarray(0, 16);
  const tag = blob.subarray(16, 32);
  const ciphertext = blob.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
}

// ---- Config load / save with v1→v2 migration ----

export function loadConfig(): BuhdiConfig {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

    // V1 detection: no version field, has plaintext apiKey
    if (!raw.version && raw.apiKey) {
      // Migrate v1 → v2
      const { encrypted, salt } = encryptApiKey(raw.apiKey);
      const v2: BuhdiConfig = {
        version: 2,
        apiKey_encrypted: encrypted,
        apiKey_salt: salt,
        nodeId: raw.nodeId,
        healthPort: 9847,
      };
      saveConfig(v2);
      return v2;
    }

    if (raw.version === 2) return raw as BuhdiConfig;

    // Unknown format, return defaults
    return { version: 2, healthPort: 9847 };
  } catch {
    return { version: 2, healthPort: 9847 };
  }
}

export function saveConfig(config: BuhdiConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/** Get the plaintext API key (decrypted from config) */
export function getApiKey(config?: BuhdiConfig): string | undefined {
  const cfg = config || loadConfig();
  if (cfg.apiKey_encrypted && cfg.apiKey_salt) {
    try {
      return decryptApiKey(cfg.apiKey_encrypted, cfg.apiKey_salt);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Store an API key (encrypts and saves) */
export function setApiKey(key: string): void {
  const config = loadConfig();
  const { encrypted, salt } = encryptApiKey(key);
  config.apiKey_encrypted = encrypted;
  config.apiKey_salt = salt;
  saveConfig(config);
}
