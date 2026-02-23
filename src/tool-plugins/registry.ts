/**
 * Tool Plugin Registry
 * 
 * Manages tool plugins: loads them, provides credential wiring,
 * generates LLM-compatible tool schemas, and dispatches executions.
 */

import fs from 'fs';
import path from 'path';
import { ToolPlugin, ToolResult, LLMToolSchema, SafetyTier } from './types';
import { addActivity, broadcastToDashboard } from '../health';

// Credential vault file (same as health.ts)
const CONFIG_DIR = process.env.BUHDI_NODE_CONFIG_DIR || path.join(require('os').homedir(), '.buhdi-node');
const CRED_FILE = path.join(CONFIG_DIR, 'credentials.enc.json');

interface CredentialEntry {
  encrypted: string;
  meta: {
    storageMode: string;
    toolType: string;
    addedAt: string;
    lastUsedAt: string | null;
  };
}

/** Read credential store from disk */
function loadCredentialStore(): Record<string, CredentialEntry> {
  try {
    if (fs.existsSync(CRED_FILE)) {
      return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

/** Decrypt a credential using machine-derived key */
function decryptCredential(blob: string): string {
  const crypto = require('crypto');
  const os = require('os');
  
  // M1-FIX: Always use machine-secret file; auto-generate if missing
  const secretDir = path.join(os.homedir(), '.buhdi');
  const secretPath = path.join(secretDir, 'machine-secret');
  let secret: Buffer;
  try {
    secret = fs.readFileSync(secretPath);
  } catch {
    secret = crypto.randomBytes(32);
    try {
      if (!fs.existsSync(secretDir)) fs.mkdirSync(secretDir, { recursive: true });
      fs.writeFileSync(secretPath, secret, { mode: 0o600 });
    } catch {}
  }
  const key = crypto.pbkdf2Sync(secret, 'buhdi-cred-vault', 100_000, 32, 'sha256');
  
  const { iv, tag, ct } = JSON.parse(blob);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  let pt = decipher.update(ct, 'base64', 'utf8');
  pt += decipher.final('utf8');
  return pt;
}

/** Rate limit tracker */
const rateLimits = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(actionKey: string, limit: number): boolean {
  if (!limit || limit <= 0) return true;
  const now = Date.now();
  const entry = rateLimits.get(actionKey);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(actionKey, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  if (entry.count >= limit) return false;
  entry.count++;
  return true;
}

export class ToolPluginRegistry {
  private plugins = new Map<string, ToolPlugin>();
  private initialized = new Map<string, boolean>();
  
  /** Register a tool plugin */
  register(plugin: ToolPlugin): void {
    this.plugins.set(plugin.name, plugin);
    console.log(`🔧 Registered tool plugin: ${plugin.name} (${plugin.actions.length} actions)`);
  }
  
  /** Get all registered plugins */
  getAll(): ToolPlugin[] {
    return Array.from(this.plugins.values());
  }
  
  /** Get a specific plugin */
  get(name: string): ToolPlugin | undefined {
    return this.plugins.get(name);
  }
  
  /** Get plugins that have credentials configured */
  getConfigured(): ToolPlugin[] {
    const store = loadCredentialStore();
    return this.getAll().filter(p => {
      // Check if all required credentials are present
      return p.credentials.every(spec => {
        if (!spec.required) return true;
        return !!store[p.name];
      });
    });
  }

  /** Initialize a plugin with its credentials from the vault */
  async initPlugin(name: string): Promise<boolean> {
    const plugin = this.plugins.get(name);
    if (!plugin) return false;
    
    const store = loadCredentialStore();
    const entry = store[name];
    if (!entry) {
      console.log(`⚠️  No credentials for ${name}`);
      return false;
    }
    
    try {
      const plaintext = decryptCredential(entry.encrypted);
      // Build credential map — for now, single key per tool
      // In future, support multiple credential fields per tool
      const creds: Record<string, string> = {};
      if (plugin.credentials.length === 1) {
        creds[plugin.credentials[0].key] = plaintext;
      } else {
        // Try parsing as JSON for multi-field credentials
        try {
          const parsed = JSON.parse(plaintext);
          Object.assign(creds, parsed);
        } catch {
          creds[plugin.credentials[0].key] = plaintext;
        }
      }
      
      const ok = await plugin.init(creds);
      this.initialized.set(name, ok);
      if (ok) {
        console.log(`✅ Tool plugin initialized: ${name}`);
      } else {
        console.log(`❌ Tool plugin init failed: ${name}`);
      }
      return ok;
    } catch (err: any) {
      console.error(`❌ Failed to init ${name}:`, err.message);
      this.initialized.set(name, false);
      return false;
    }
  }
  
  /** Initialize all plugins that have credentials */
  async initAll(): Promise<void> {
    const store = loadCredentialStore();
    for (const plugin of this.plugins.values()) {
      if (store[plugin.name]) {
        await this.initPlugin(plugin.name);
      }
    }
  }
  
  /** Check if a plugin is initialized and ready */
  isReady(name: string): boolean {
    return this.initialized.get(name) === true;
  }
  
  /**
   * Generate OpenAI-compatible tool schemas for all configured plugins.
   * Used by the LLM router to tell the model what tools are available.
   */
  getLLMToolSchemas(): LLMToolSchema[] {
    const schemas: LLMToolSchema[] = [];
    for (const plugin of this.getConfigured()) {
      if (!this.isReady(plugin.name)) continue;
      for (const action of plugin.actions) {
        schemas.push({
          type: 'function',
          function: {
            name: `${plugin.name}_${action.name}`,
            description: `[${plugin.category}] ${action.description}`,
            parameters: action.parameters,
          },
        });
      }
    }
    return schemas;
  }
  
  /**
   * Execute a tool action.
   * Format: toolName = 'gmail', action = 'send_email', params = { to, subject, body }
   * OR combined: toolAction = 'gmail_send_email'
   */
  async execute(
    toolName: string,
    actionName: string,
    params: Record<string, any>,
  ): Promise<ToolResult> {
    const plugin = this.plugins.get(toolName);
    if (!plugin) {
      return { success: false, output: `Unknown tool: ${toolName}`, error: 'TOOL_NOT_FOUND' };
    }
    
    // Find the action definition
    const actionDef = plugin.actions.find(a => a.name === actionName);
    if (!actionDef) {
      return {
        success: false,
        output: `Unknown action: ${actionName} for tool ${toolName}`,
        error: 'ACTION_NOT_FOUND',
      };
    }
    
    // Check initialization
    if (!this.isReady(toolName)) {
      // Try to init now
      const ok = await this.initPlugin(toolName);
      if (!ok) {
        return {
          success: false,
          output: `Tool ${toolName} is not configured or credentials are invalid`,
          error: 'NOT_INITIALIZED',
        };
      }
    }
    
    // Safety tier check — never bypassed
    {
      if (actionDef.safety === SafetyTier.ADMIN) {
        return {
          success: false,
          output: `Action ${actionName} requires admin approval and is currently blocked`,
          error: 'SAFETY_BLOCKED',
        };
      }
      // Financial and Delete tiers will eventually require user confirmation
      // For now, log a warning
      if (actionDef.safety === SafetyTier.FINANCIAL || actionDef.safety === SafetyTier.DELETE) {
        console.log(`⚠️  Safety tier ${actionDef.safety}: ${toolName}.${actionName} — auto-approved (confirmation UI coming)`);
      }
    }
    
    // Rate limit check
    const rateKey = `${toolName}_${actionName}`;
    if (actionDef.rateLimit && !checkRateLimit(rateKey, actionDef.rateLimit)) {
      return {
        success: false,
        output: `Rate limit exceeded for ${toolName}.${actionName} (max ${actionDef.rateLimit}/min)`,
        error: 'RATE_LIMITED',
      };
    }
    
    // Execute
    const start = Date.now();
    try {
      const result = await plugin.execute(actionName, params);
      const duration = Date.now() - start;
      
      // Log activity
      const icon = result.success ? '✅' : '❌';
      addActivity(icon, `${plugin.displayName}: ${actionName} (${duration}ms)`);
      
      // Broadcast to dashboard
      broadcastToDashboard({
        type: 'tool.executed',
        tool: toolName,
        action: actionName,
        success: result.success,
        duration,
      });
      
      return result;
    } catch (err: any) {
      const duration = Date.now() - start;
      addActivity('❌', `${plugin.displayName}: ${actionName} FAILED (${duration}ms)`);
      return {
        success: false,
        output: `Tool execution error: ${err.message}`,
        error: err.message,
      };
    }
  }
  
  /**
   * Parse a combined tool_action string (e.g., 'gmail_send_email')
   * and execute it.
   */
  async executeByFullName(
    toolAction: string,
    params: Record<string, any>,
  ): Promise<ToolResult> {
    // Find matching plugin by checking all registered names
    for (const plugin of this.plugins.values()) {
      for (const action of plugin.actions) {
        if (`${plugin.name}_${action.name}` === toolAction) {
          return this.execute(plugin.name, action.name, params);
        }
      }
    }
    return {
      success: false,
      output: `Unknown tool action: ${toolAction}`,
      error: 'NOT_FOUND',
    };
  }

  /** Get status summary for all plugins */
  getStatus(): Array<{
    name: string;
    displayName: string;
    category: string;
    configured: boolean;
    ready: boolean;
    actionCount: number;
  }> {
    const store = loadCredentialStore();
    return this.getAll().map(p => ({
      name: p.name,
      displayName: p.displayName,
      category: p.category,
      configured: !!store[p.name],
      ready: this.isReady(p.name),
      actionCount: p.actions.length,
    }));
  }
}

// Singleton
export const toolRegistry = new ToolPluginRegistry();
