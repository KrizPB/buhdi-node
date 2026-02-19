/**
 * Vault — RSA-4096 keypair management for buhdi-node
 * Private key stored encrypted at ~/.buhdi/vault-key.enc
 *
 * Security model:
 * - Random 32-byte salt per install (stored at ~/.buhdi/vault-salt)
 * - Random 32-byte machine secret per install (stored at ~/.buhdi/machine-secret, chmod 600)
 * - PBKDF2 with 600K iterations derives AES-256-GCM key from machine-secret + salt
 * - Private key encrypted at rest, cached in memory with 5-minute auto-clear
 * - All vault files written with mode 0o600 (owner read/write only)
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const VAULT_DIR = path.join(os.homedir(), '.buhdi');
const KEY_FILE = path.join(VAULT_DIR, 'vault-key.enc');
const PUBKEY_FILE = path.join(VAULT_DIR, 'vault-pub.pem');
const SALT_FILE = path.join(VAULT_DIR, 'vault-salt');
const SECRET_FILE = path.join(VAULT_DIR, 'machine-secret');

const PBKDF2_ITERATIONS = 600_000; // INFO-1: Raised from 100K to 600K for consistency
const CACHE_TTL_MS = 5 * 60 * 1000; // HIGH-2: 5-minute cache timeout

let cachedPrivateKey: crypto.KeyObject | null = null;
let cachedPublicKeyPem: string | null = null;
let cacheTimer: ReturnType<typeof setTimeout> | null = null;

/** Reset the cache expiry timer. Called on every private key access. */
function touchCache(): void {
  if (cacheTimer) clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    cachedPrivateKey = null;
    cacheTimer = null;
    console.log('🔐 Private key cache cleared (5-minute timeout)');
  }, CACHE_TTL_MS);
}

/** Write a file with restricted permissions (owner read/write only) */
async function writeSecure(filePath: string, data: Buffer | string): Promise<void> {
  const opts = typeof data === 'string'
    ? { encoding: 'utf8' as const, mode: 0o600 }
    : { mode: 0o600 };
  await fs.writeFile(filePath, data, opts);
}

/** Get or create the random salt for this install */
async function getSalt(): Promise<Buffer> {
  try {
    return await fs.readFile(SALT_FILE);
  } catch {
    const salt = crypto.randomBytes(32);
    await writeSecure(SALT_FILE, salt);
    return salt;
  }
}

/** Get or create the random machine secret for this install */
async function getMachineSecret(): Promise<Buffer> {
  try {
    return await fs.readFile(SECRET_FILE);
  } catch {
    const secret = crypto.randomBytes(32);
    await writeSecure(SECRET_FILE, secret);
    return secret;
  }
}

/** Derive an encryption key from machine-secret + random salt */
async function deriveMachineKey(): Promise<Buffer> {
  const [secret, salt] = await Promise.all([getMachineSecret(), getSalt()]);
  return crypto.pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, 32, 'sha256');
}

/** Encrypt data with machine-derived key */
async function encryptWithMachineKey(data: string): Promise<Buffer> {
  const key = await deriveMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(16) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]);
}

/** Decrypt data with machine-derived key */
async function decryptWithMachineKey(data: Buffer): Promise<string> {
  const key = await deriveMachineKey();
  const iv = data.subarray(0, 16);
  const tag = data.subarray(16, 32);
  const ciphertext = data.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext) + decipher.final('utf8');
}

/** Generate RSA-4096 keypair and store securely */
async function generateKeypair(): Promise<void> {
  console.log('🔐 Generating RSA-4096 keypair for vault...');
  
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  await fs.mkdir(VAULT_DIR, { recursive: true, mode: 0o700 });

  // Ensure salt and machine secret exist before encrypting
  await getSalt();
  await getMachineSecret();

  // Store private key encrypted (HIGH-1: mode 0o600)
  const encryptedPrivate = await encryptWithMachineKey(privateKey as string);
  await writeSecure(KEY_FILE, encryptedPrivate);
  
  // Store public key as PEM (not sensitive, but still restricted)
  await writeSecure(PUBKEY_FILE, publicKey as string);

  // Cache in memory
  cachedPrivateKey = crypto.createPrivateKey(privateKey as string);
  cachedPublicKeyPem = publicKey as string;
  touchCache();

  console.log('✅ RSA keypair generated and stored');
}

/** Load existing keypair from disk */
async function loadKeypair(): Promise<boolean> {
  try {
    const [encPrivate, pubPem] = await Promise.all([
      fs.readFile(KEY_FILE),
      fs.readFile(PUBKEY_FILE, 'utf8'),
    ]);
    
    const privatePem = await decryptWithMachineKey(encPrivate);
    cachedPrivateKey = crypto.createPrivateKey(privatePem);
    cachedPublicKeyPem = pubPem;
    touchCache();
    return true;
  } catch {
    return false;
  }
}

/** Ensure keypair exists — generate if not */
export async function ensureKeypair(): Promise<void> {
  if (cachedPrivateKey && cachedPublicKeyPem) {
    touchCache();
    return;
  }
  
  const loaded = await loadKeypair();
  if (!loaded) {
    await generateKeypair();
  }
}

/** Get the private key, re-loading from disk if cache expired */
async function getPrivateKey(): Promise<crypto.KeyObject> {
  if (!cachedPrivateKey) {
    const loaded = await loadKeypair();
    if (!loaded) throw new Error('Keypair not initialized. Call ensureKeypair() first.');
  }
  touchCache();
  return cachedPrivateKey!;
}

/** Get the public key as base64-encoded DER (for sending to cloud) */
export function getPublicKey(): string {
  if (!cachedPublicKeyPem) throw new Error('Keypair not initialized. Call ensureKeypair() first.');
  // Strip PEM headers and return raw base64
  return cachedPublicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, '')
    .replace(/-----END PUBLIC KEY-----/g, '')
    .replace(/\s/g, '');
}

/** Get the full PEM public key */
export function getPublicKeyPem(): string {
  if (!cachedPublicKeyPem) throw new Error('Keypair not initialized');
  return cachedPublicKeyPem;
}

/** Decrypt an RSA-OAEP wrapped AES key */
export async function decryptWithPrivateKey(encryptedAESKeyBase64: string): Promise<Buffer> {
  const privateKey = await getPrivateKey();
  
  const encryptedBuffer = Buffer.from(encryptedAESKeyBase64, 'base64');
  return crypto.privateDecrypt(
    {
      key: privateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    encryptedBuffer
  );
}

/** Decrypt a vault secret: unwrap AES key with RSA, then decrypt value with AES-GCM */
export async function decryptVaultSecret(
  encryptedValue: string,
  iv: string,
  authTag: string,
  wrappedAESKey: string
): Promise<string> {
  // Step 1: Unwrap the AES key
  const aesKeyRaw = await decryptWithPrivateKey(wrappedAESKey);
  
  // Step 2: Decrypt with AES-256-GCM
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    aesKeyRaw,
    Buffer.from(iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedValue, 'base64')),
    decipher.final(),
  ]);
  
  return decrypted.toString('utf8');
}
