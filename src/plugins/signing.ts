/**
 * Code Signing — Ed25519 signature verification for plugin deploys
 *
 * SECURITY CRITICAL: Every code bundle must be verified before touching disk.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logAudit } from './audit';

const DEPLOY_KEY_PATH = path.join(os.homedir(), '.buhdi-node', 'deploy-key.pub');
const BASE_URL = 'https://www.mybuhdi.com';

/**
 * Fetch the Ed25519 deploy public key from cloud and cache locally.
 */
export async function fetchDeployKey(apiKey: string): Promise<string | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/node/deploy-key`, {
      headers: { 'x-node-key': apiKey },
    });
    if (!res.ok) {
      console.warn(`⚠️  Failed to fetch deploy key (${res.status})`);
      return null;
    }
    const data = await res.json() as any;
    const publicKey = data.data?.publicKey || data.publicKey;
    if (!publicKey) {
      console.warn('⚠️  No deploy key in response');
      return null;
    }
    // HIGH: TOFU (Trust On First Use) — only accept if no key cached, warn on change
    const existingKey = loadDeployKey();
    if (existingKey && existingKey !== publicKey) {
      console.error('🚨 SECURITY WARNING: Deploy key from cloud differs from cached key!');
      console.error('   This could indicate a compromised cloud. Key NOT updated.');
      console.error('   To accept new key, manually delete: ' + DEPLOY_KEY_PATH);
      logAudit({
        action: 'error',
        toolId: 'signing',
        version: '0',
        initiatedBy: 'cloud',
        reason: 'Deploy key change detected — TOFU violation. Key NOT updated.',
      });
      return existingKey;
    }
    // Cache locally (first use or same key)
    saveDeployKey(publicKey);
    if (!existingKey) console.log('🔐 Deploy signing key cached (first use)');
    return publicKey;
  } catch (err: any) {
    console.warn('⚠️  Deploy key fetch failed:', err.message);
    return null;
  }
}

/**
 * Save the deploy public key to disk.
 */
export function saveDeployKey(publicKeyHex: string): void {
  const dir = path.dirname(DEPLOY_KEY_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(DEPLOY_KEY_PATH, publicKeyHex, { mode: 0o600 });
}

/**
 * Load the cached deploy public key from disk.
 */
export function loadDeployKey(): string | null {
  try {
    return fs.readFileSync(DEPLOY_KEY_PATH, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * Verify an Ed25519 signature on a code bundle.
 *
 * @param codeBundle - The plugin source code
 * @param signature - Hex-encoded Ed25519 signature
 * @param nonce - Nonce to prevent replay attacks
 * @param publicKeyHex - Hex-encoded Ed25519 public key (optional, loads from cache)
 * @returns true if signature is valid
 */
export function verifyDeploySignature(
  codeBundle: string,
  signature: string,
  nonce: string,
  publicKeyHex?: string
): boolean {
  const keyHex = publicKeyHex || loadDeployKey();
  if (!keyHex) {
    logAudit({
      action: 'error',
      toolId: 'signing',
      version: '0',
      initiatedBy: 'system',
      reason: 'No deploy key available — cannot verify signature',
    });
    return false;
  }

  try {
    // Hash: sha256(codeBundle + nonce)
    const dataToSign = codeBundle + nonce;
    const hash = crypto.createHash('sha256').update(dataToSign).digest();

    // Build the Ed25519 public key object
    const publicKeyBuffer = Buffer.from(keyHex, 'hex');
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([
        // Ed25519 DER prefix for 32-byte raw key
        Buffer.from('302a300506032b6570032100', 'hex'),
        publicKeyBuffer,
      ]),
      format: 'der',
      type: 'spki',
    });

    const signatureBuffer = Buffer.from(signature, 'hex');

    // Ed25519 signs the data directly (not a hash), but our protocol
    // signs sha256(codeBundle + nonce) for consistency
    return crypto.verify(null, hash, publicKey, signatureBuffer);
  } catch (err: any) {
    logAudit({
      action: 'error',
      toolId: 'signing',
      version: '0',
      initiatedBy: 'system',
      reason: `Signature verification error: ${err.message}`,
    });
    return false;
  }
}

/**
 * Compute the sha256 hash of a code bundle + nonce (for verification).
 */
export function computeCodeHash(codeBundle: string, nonce: string): string {
  return crypto.createHash('sha256').update(codeBundle + nonce).digest('hex');
}
