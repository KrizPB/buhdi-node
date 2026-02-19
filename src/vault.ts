/**
 * Vault — RSA-4096 keypair management for buhdi-node
 * Private key stored encrypted at ~/.buhdi/vault-key.pem
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const VAULT_DIR = path.join(os.homedir(), '.buhdi');
const KEY_FILE = path.join(VAULT_DIR, 'vault-key.enc');
const PUBKEY_FILE = path.join(VAULT_DIR, 'vault-pub.pem');

let cachedPrivateKey: crypto.KeyObject | null = null;
let cachedPublicKeyPem: string | null = null;

/** Derive an encryption key from machine-specific info */
function deriveMachineKey(): Buffer {
  const machineId = `${os.hostname()}:${os.platform()}:${os.arch()}:${os.userInfo().username}`;
  const salt = 'buhdi-vault-v1';
  return crypto.pbkdf2Sync(machineId, salt, 100000, 32, 'sha256');
}

/** Encrypt data with machine-derived key */
function encryptWithMachineKey(data: string): Buffer {
  const key = deriveMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(16) + tag(16) + ciphertext
  return Buffer.concat([iv, tag, encrypted]);
}

/** Decrypt data with machine-derived key */
function decryptWithMachineKey(data: Buffer): string {
  const key = deriveMachineKey();
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

  await fs.mkdir(VAULT_DIR, { recursive: true });

  // Store private key encrypted
  const encryptedPrivate = encryptWithMachineKey(privateKey as string);
  await fs.writeFile(KEY_FILE, encryptedPrivate);
  
  // Store public key as PEM (not sensitive)
  await fs.writeFile(PUBKEY_FILE, publicKey as string);

  // Cache in memory
  cachedPrivateKey = crypto.createPrivateKey(privateKey as string);
  cachedPublicKeyPem = publicKey as string;

  console.log('✅ RSA keypair generated and stored');
}

/** Load existing keypair from disk */
async function loadKeypair(): Promise<boolean> {
  try {
    const [encPrivate, pubPem] = await Promise.all([
      fs.readFile(KEY_FILE),
      fs.readFile(PUBKEY_FILE, 'utf8'),
    ]);
    
    const privatePem = decryptWithMachineKey(encPrivate);
    cachedPrivateKey = crypto.createPrivateKey(privatePem);
    cachedPublicKeyPem = pubPem;
    return true;
  } catch {
    return false;
  }
}

/** Ensure keypair exists — generate if not */
export async function ensureKeypair(): Promise<void> {
  if (cachedPrivateKey && cachedPublicKeyPem) return;
  
  const loaded = await loadKeypair();
  if (!loaded) {
    await generateKeypair();
  }
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
export function decryptWithPrivateKey(encryptedAESKeyBase64: string): Buffer {
  if (!cachedPrivateKey) throw new Error('Keypair not initialized');
  
  const encryptedBuffer = Buffer.from(encryptedAESKeyBase64, 'base64');
  return crypto.privateDecrypt(
    {
      key: cachedPrivateKey,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    encryptedBuffer
  );
}

/** Decrypt a vault secret: unwrap AES key with RSA, then decrypt value with AES-GCM */
export function decryptVaultSecret(
  encryptedValue: string,
  iv: string,
  authTag: string,
  wrappedAESKey: string
): string {
  // Step 1: Unwrap the AES key
  const aesKeyRaw = decryptWithPrivateKey(wrappedAESKey);
  
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
