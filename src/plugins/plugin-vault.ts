/**
 * Plugin Vault — encrypted-at-rest secret storage for plugins
 *
 * Each plugin gets an isolated vault at ~/.buhdi-node/plugins/<name>/vault.enc
 * Encryption: AES-256-GCM with PBKDF2-derived key from machine-secret
 * Secrets NEVER appear in logs, errors, or audit trails.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const PLUGINS_DIR = path.join(os.homedir(), '.buhdi-node', 'plugins');
const SECRET_FILE = path.join(os.homedir(), '.buhdi', 'machine-secret');
const PBKDF2_ITERATIONS = 600_000;

// C3-M1 fix: Validate plugin names to prevent path traversal
const SAFE_NAME_RE = /^[a-zA-Z0-9_-]+$/;
function validatePluginName(name: string): void {
  if (!name || !SAFE_NAME_RE.test(name)) {
    throw new Error('Invalid plugin name');
  }
}

interface EncryptedEntry {
  iv: string;       // base64
  authTag: string;  // base64
  ciphertext: string; // base64
}

interface VaultData {
  [key: string]: EncryptedEntry;
}

/** Get or create the machine secret (same as vault.ts) */
async function getMachineSecret(): Promise<Buffer> {
  try {
    return await fs.readFile(SECRET_FILE);
  } catch {
    const secret = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(SECRET_FILE), { recursive: true });
    await fs.writeFile(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  }
}

/** Get or create per-plugin salt */
async function getPluginSalt(pluginName: string): Promise<Buffer> {
  const saltFile = path.join(PLUGINS_DIR, pluginName, 'vault.salt');
  try {
    return await fs.readFile(saltFile);
  } catch {
    const salt = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(saltFile), { recursive: true });
    await fs.writeFile(saltFile, salt, { mode: 0o600 });
    return salt;
  }
}

/** Derive encryption key for a plugin's vault */
async function derivePluginKey(pluginName: string): Promise<Buffer> {
  const [secret, salt] = await Promise.all([getMachineSecret(), getPluginSalt(pluginName)]);
  return crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

function vaultPath(pluginName: string): string {
  return path.join(PLUGINS_DIR, pluginName, 'vault.enc');
}

async function readVault(pluginName: string): Promise<VaultData> {
  try {
    const raw = await fs.readFile(vaultPath(pluginName), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function writeVault(pluginName: string, data: VaultData): Promise<void> {
  const fp = vaultPath(pluginName);
  await fs.mkdir(path.dirname(fp), { recursive: true });
  await fs.writeFile(fp, JSON.stringify(data), { mode: 0o600 });
}

/**
 * Get a plugin secret. Returns null if key not in permissions or doesn't exist.
 * NEVER throws with secret values in error messages.
 */
export async function getPluginSecret(
  pluginName: string,
  key: string,
  permissions: string[]
): Promise<string | null> {
  validatePluginName(pluginName);
  if (!permissions.includes(key) && !permissions.includes('*')) {
    return null;
  }

  const vault = await readVault(pluginName);
  const entry = vault[key];
  if (!entry) return null;

  try {
    const derivedKey = await derivePluginKey(pluginName);
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      derivedKey,
      Buffer.from(entry.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(entry.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(entry.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch {
    // NEVER leak secret data in error messages
    return null;
  }
}

/**
 * Set (encrypt and store) a plugin secret.
 */
export async function setPluginSecret(
  pluginName: string,
  key: string,
  value: string
): Promise<void> {
  validatePluginName(pluginName);
  const derivedKey = await derivePluginKey(pluginName);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const vault = await readVault(pluginName);
  vault[key] = {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  };
  await writeVault(pluginName, vault);
}

/**
 * Delete a single secret from a plugin's vault.
 */
export async function deletePluginSecret(pluginName: string, key: string): Promise<void> {
  validatePluginName(pluginName);
  const vault = await readVault(pluginName);
  delete vault[key];
  await writeVault(pluginName, vault);
}

/**
 * List secret key names (never values) for a plugin.
 */
export async function listPluginSecrets(pluginName: string): Promise<string[]> {
  validatePluginName(pluginName);
  const vault = await readVault(pluginName);
  return Object.keys(vault);
}

/**
 * Delete entire plugin vault (used on uninstall).
 */
export async function deletePluginVault(pluginName: string): Promise<void> {
  validatePluginName(pluginName);
  try {
    await fs.unlink(vaultPath(pluginName));
  } catch { /* may not exist */ }
  try {
    await fs.unlink(path.join(PLUGINS_DIR, pluginName, 'vault.salt'));
  } catch { /* may not exist */ }
}
