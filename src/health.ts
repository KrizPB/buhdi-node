/**
 * Health + Dashboard HTTP server for buhdi-node.
 * Serves the web UI, REST API, and WebSocket connections.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { getDashboardToken } from './dashboard';

const VERSION = '0.3.0';
const startTime = Date.now();

// Static file MIME types
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// Dashboard files directory
const DASHBOARD_DIR = path.join(__dirname, 'dashboard');

// ---- Mutable State ----
let _state = {
  connectionState: 'DISCONNECTED' as string,
  nodeId: null as string | null,
  nodeName: null as string | null,
  lastTaskAt: null as string | null,
  wsConnected: false,
  pluginCount: 0,
  pluginStatuses: [] as Array<{ name: string; version: string; status: string }>,
  tools: [] as Array<{ name: string; available: boolean; version?: string }>,
  system: null as any,
  tasks: { running: [] as any[], completed: [] as any[], pending: 0 },
  activity: [] as Array<{ time: string; icon: string; text: string }>,
};

// Connected dashboard WebSocket clients
const dashClients = new Set<WebSocket>();

export function updateHealthState(partial: Partial<typeof _state>): void {
  Object.assign(_state, partial);
  // Broadcast status to dashboard clients
  broadcastToDashboard({ type: 'status.update', ...getStatusPayload() });
}

export function broadcastToDashboard(data: any): void {
  const msg = JSON.stringify(data);
  for (const ws of dashClients) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

function getStatusPayload() {
  const healthy = _state.wsConnected || _state.connectionState === 'POLLING';
  return {
    state: healthy ? 'connected' : 'disconnected',
    version: VERSION,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    connectionState: _state.connectionState,
    nodeId: _state.nodeId,
    nodeName: _state.nodeName,
    lastTaskAt: _state.lastTaskAt,
    wsConnected: _state.wsConnected,
    tools: _state.tools,
    system: _state.system,
    tasks: _state.tasks,
    activity: _state.activity,
    config: {
      healthPort: 9847,
      apiKeyMasked: '●●●●●●●●●●',
    },
    plugins: {
      count: _state.pluginCount,
      statuses: _state.pluginStatuses,
    },
  };
}

function addActivity(icon: string, text: string): void {
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  _state.activity.unshift({ time, icon, text });
  if (_state.activity.length > 50) _state.activity.pop();
}

export { addActivity };

// ---- Chat handler (to be wired to cloud relay) ----
let chatHandler: ((message: string, ws: WebSocket) => void) | null = null;

export function setChatHandler(handler: (message: string, ws: WebSocket) => void): void {
  chatHandler = handler;
}

// ---- HTTP Server ----
export function startHealthServer(port: number): http.Server | null {
  if (!port || port === 0) return null;

  // Auth token — required for all API endpoints except /api/health and static files
  const dashToken = getDashboardToken();

  function requireAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    // Static files and health check don't need auth
    // API endpoints require Bearer token
    const authHeader = req.headers.authorization || '';
    const queryToken = new URL(req.url || '/', `http://localhost:${port}`).searchParams.get('token');
    const token = authHeader.replace(/^Bearer\s+/i, '') || queryToken || '';
    if (!dashToken || token === dashToken) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    // CORS — restrict to same origin (localhost only)
    const origin = req.headers.origin || '';
    if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ---- Public endpoints (no auth) ----
    if (pathname === '/api/health') {
      const healthy = _state.wsConnected || _state.connectionState === 'POLLING';
      return jsonResponse(res, { status: healthy ? 'healthy' : 'unhealthy' }, healthy ? 200 : 503);
    }

    // ---- Static files (no auth — served from same origin) ----
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(res, path.join(DASHBOARD_DIR, 'index.html'));
    }
    if (pathname.startsWith('/dashboard/')) {
      const filePath = path.join(DASHBOARD_DIR, pathname.replace('/dashboard/', ''));
      return serveFile(res, filePath);
    }

    // ---- All API routes below require auth ----
    if (!requireAuth(req, res)) return;

    // ---- API Routes ----
    if (pathname === '/api/status') {
      return jsonResponse(res, getStatusPayload());
    }

    if (pathname === '/api/tasks') {
      return jsonResponse(res, _state.tasks);
    }

    if (pathname === '/api/tools') {
      return jsonResponse(res, { tools: _state.tools });
    }

    if (pathname === '/api/logs') {
      return jsonResponse(res, { logs: _state.activity.slice(0, 30) });
    }

    if (pathname === '/api/config') {
      return jsonResponse(res, {
        healthPort: 9847,
        apiKeyMasked: '●●●●●●●●●●',
        nodeName: _state.nodeName,
      });
    }

    if (pathname === '/api/files' && req.method === 'GET') {
      return handleFilesList(res);
    }

    if (pathname.startsWith('/api/files/') && req.method === 'GET') {
      const name = decodeURIComponent(pathname.slice('/api/files/'.length));
      return handleFileRead(res, name);
    }

    if (pathname.startsWith('/api/files/') && req.method === 'PUT') {
      const name = decodeURIComponent(pathname.slice('/api/files/'.length));
      return readBody(req, (body) => handleFileWrite(res, name, body));
    }

    if (pathname === '/api/chat/send' && req.method === 'POST') {
      return readBody(req, (body) => {
        const { message } = JSON.parse(body);
        // For now, echo back — will be wired to cloud relay
        broadcastToDashboard({
          type: 'chat.message',
          role: 'assistant',
          content: `[Node received] "${message}" — Cloud relay not yet connected. Chat will be routed through mybuhdi.com in Phase 2.`,
          ts: new Date().toISOString(),
        });
        addActivity('💬', `Chat: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);
        jsonResponse(res, { ok: true });
      });
    }

    // ---- Tool Plugin API ----
    if (pathname === '/api/tool-plugins' && req.method === 'GET') {
      const { toolRegistry } = require('./tool-plugins');
      return jsonResponse(res, { plugins: toolRegistry.getStatus(), schemas: toolRegistry.getLLMToolSchemas() });
    }

    if (pathname.startsWith('/api/tool-plugins/') && pathname.endsWith('/execute') && req.method === 'POST') {
      const parts = pathname.slice('/api/tool-plugins/'.length).split('/');
      const toolName = decodeURIComponent(parts[0]);
      return readBody(req, async (body) => {
        try {
          const { action, params } = JSON.parse(body);
          const { toolRegistry } = require('./tool-plugins');
          const result = await toolRegistry.execute(toolName, action, params || {});
          jsonResponse(res, result);
        } catch (err: any) {
          jsonResponse(res, { success: false, error: err.message }, 500);
        }
      });
    }

    if (pathname.startsWith('/api/tool-plugins/') && pathname.endsWith('/test') && req.method === 'POST') {
      const parts = pathname.slice('/api/tool-plugins/'.length).split('/');
      const toolName = decodeURIComponent(parts[0]);
      const { toolRegistry } = require('./tool-plugins');
      const plugin = toolRegistry.get(toolName);
      if (!plugin) return jsonResponse(res, { error: 'Plugin not found' }, 404);
      (async () => {
        try {
          await toolRegistry.initPlugin(toolName);
          const result = await plugin.testCredentials();
          jsonResponse(res, result);
        } catch (err: any) {
          jsonResponse(res, { success: false, error: err.message }, 500);
        }
      })();
      return;
    }

    // ---- Credential Vault API ----
    if (pathname === '/api/credentials' && req.method === 'GET') {
      return handleCredentialsList(res);
    }

    if (pathname.startsWith('/api/credentials/') && req.method === 'POST') {
      const parts = pathname.slice('/api/credentials/'.length).split('/');
      const toolName = decodeURIComponent(parts[0]);
      if (parts[1] === 'test') {
        return handleCredentialTest(res, toolName);
      }
      return readBody(req, (body) => handleCredentialSave(res, toolName, body));
    }

    if (pathname.startsWith('/api/credentials/') && req.method === 'DELETE') {
      const toolName = decodeURIComponent(pathname.slice('/api/credentials/'.length));
      return handleCredentialDelete(res, toolName);
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  // ---- WebSocket Server ----
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // N1-FIX: Verify auth token on WebSocket upgrade
    if (dashToken) {
      const wsUrl = new URL(req.url || '/', `http://localhost:${port}`);
      const token = wsUrl.searchParams.get('token') || '';
      if (token !== dashToken) {
        ws.close(4401, 'Unauthorized');
        return;
      }
    }

    dashClients.add(ws);
    // Send current status immediately
    ws.send(JSON.stringify({ type: 'status.update', ...getStatusPayload() }));

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.type === 'chat.send' && data.message) {
          if (chatHandler) {
            chatHandler(data.message, ws);
          } else {
            // Echo placeholder until cloud relay is connected
            ws.send(JSON.stringify({
              type: 'chat.message',
              role: 'assistant',
              content: `[Node received] "${data.message}" — Cloud chat relay coming in Phase 2.`,
              ts: new Date().toISOString(),
            }));
          }
          addActivity('💬', `Chat: "${data.message.substring(0, 50)}"`);
        }
      } catch {}
    });

    ws.on('close', () => {
      dashClients.delete(ws);
    });
  });

  server.listen(port, '127.0.0.1', () => {
    // logged by caller
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`⚠️  Health port ${port} already in use`);
    }
  });

  return server;
}

// ---- Helpers ----

function jsonResponse(res: http.ServerResponse, data: any, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function serveFile(res: http.ServerResponse, filePath: string): void {
  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(DASHBOARD_DIR))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(resolved);
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

const MAX_BODY_SIZE = 1024 * 1024; // L2-FIX: 1MB max request body

function readBody(req: http.IncomingMessage, cb: (body: string) => void): void {
  let body = '';
  let overflow = false;
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) { overflow = true; req.destroy(); }
  });
  req.on('end', () => { if (!overflow) cb(body); });
}

// ---- Config Files API ----
const CONFIG_FILES_DIR = path.join(process.env.BUHDI_NODE_CONFIG_DIR || path.join(require('os').homedir(), '.buhdi-node'));
const EDITABLE_EXTENSIONS = ['.md', '.txt', '.json'];
const MAX_FILE_SIZE = 100 * 1024; // 100KB

// ---- Credential Vault (Local Only — Phase 1) ----
const CRED_FILE = path.join(CONFIG_FILES_DIR, 'credentials.enc.json');

interface CredentialMeta {
  storageMode: string;
  toolType: string;
  addedAt: string;
  lastUsedAt: string | null;
}

interface CredentialStore {
  [tool: string]: {
    encrypted: string; // AES-256-GCM encrypted credential (base64 JSON: {iv, tag, ct})
    meta: CredentialMeta;
  };
}

function loadCredentialStore(): CredentialStore {
  try {
    if (fs.existsSync(CRED_FILE)) {
      return JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
    }
  } catch {}
  return {};
}

function saveCredentialStore(store: CredentialStore): void {
  if (!fs.existsSync(CONFIG_FILES_DIR)) {
    fs.mkdirSync(CONFIG_FILES_DIR, { recursive: true });
  }
  fs.writeFileSync(CRED_FILE, JSON.stringify(store, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// Simple AES-256-GCM with machine-derived key
function getMachineKey(): Buffer {
  const os = require('os');
  const crypto = require('crypto');
  // M1-FIX: Always use machine-secret file; auto-generate if missing
  const secretDir = path.join(os.homedir(), '.buhdi');
  const secretPath = path.join(secretDir, 'machine-secret');
  let secret: Buffer;
  try {
    secret = fs.readFileSync(secretPath);
  } catch {
    // Auto-generate a random 32-byte secret on first run
    secret = crypto.randomBytes(32);
    try {
      if (!fs.existsSync(secretDir)) fs.mkdirSync(secretDir, { recursive: true });
      fs.writeFileSync(secretPath, secret, { mode: 0o600 });
      console.log('🔐 Generated machine secret for credential vault');
    } catch (err: any) {
      console.warn('⚠️  Could not persist machine secret:', err.message);
    }
  }
  return crypto.pbkdf2Sync(secret, 'buhdi-cred-vault', 100_000, 32, 'sha256');
}

function encryptCredential(plaintext: string): string {
  const crypto = require('crypto');
  const key = getMachineKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let ct = cipher.update(plaintext, 'utf8', 'base64');
  ct += cipher.final('base64');
  const tag = cipher.getAuthTag().toString('base64');
  return JSON.stringify({ iv: iv.toString('base64'), tag, ct });
}

function decryptCredential(blob: string): string {
  const crypto = require('crypto');
  const key = getMachineKey();
  const { iv, tag, ct } = JSON.parse(blob);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  let pt = decipher.update(ct, 'base64', 'utf8');
  pt += decipher.final('utf8');
  return pt;
}

function handleCredentialsList(res: http.ServerResponse): void {
  const store = loadCredentialStore();
  const credentials: Record<string, CredentialMeta> = {};
  for (const [tool, entry] of Object.entries(store)) {
    credentials[tool] = entry.meta;
  }
  jsonResponse(res, { credentials });
}

function handleCredentialSave(res: http.ServerResponse, toolName: string, body: string): void {
  try {
    const { credential, storageMode, toolType } = JSON.parse(body);
    if (!credential || typeof credential !== 'string') {
      return jsonResponse(res, { error: 'Missing credential' }, 400);
    }

    const store = loadCredentialStore();
    store[toolName] = {
      encrypted: encryptCredential(credential),
      meta: {
        storageMode: storageMode || 'local_only',
        toolType: toolType || 'api_key',
        addedAt: new Date().toISOString(),
        lastUsedAt: null,
      },
    };
    saveCredentialStore(store);
    addActivity('🔒', `Credential saved: ${toolName}`);
    jsonResponse(res, { ok: true, details: `${toolName} credential saved (${storageMode || 'local_only'})` });
  } catch (err: any) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

function handleCredentialTest(res: http.ServerResponse, toolName: string): void {
  const store = loadCredentialStore();
  const entry = store[toolName];
  if (!entry) {
    return jsonResponse(res, { error: 'No credential found for ' + toolName }, 404);
  }

  try {
    // Verify we can decrypt it
    const _plaintext = decryptCredential(entry.encrypted);
    // In Phase 2, we'd actually test the API connection here
    // For now, just confirm decryption works
    entry.meta.lastUsedAt = new Date().toISOString();
    saveCredentialStore(store);
    jsonResponse(res, { ok: true, details: `Credential decrypted successfully. API test coming in Phase 2.` });
  } catch (err: any) {
    jsonResponse(res, { error: 'Decryption failed: ' + err.message }, 500);
  }
}

function handleCredentialDelete(res: http.ServerResponse, toolName: string): void {
  const store = loadCredentialStore();
  if (!store[toolName]) {
    return jsonResponse(res, { error: 'Not found' }, 404);
  }
  delete store[toolName];
  saveCredentialStore(store);
  addActivity('🗑️', `Credential removed: ${toolName}`);
  jsonResponse(res, { ok: true });
}

// ---- Config Files API ----
function handleFilesList(res: http.ServerResponse): void {
  try {
    const files: Array<{ name: string; size: number }> = [];
    if (fs.existsSync(CONFIG_FILES_DIR)) {
      for (const f of fs.readdirSync(CONFIG_FILES_DIR)) {
        const ext = path.extname(f);
        if (EDITABLE_EXTENSIONS.includes(ext)) {
          const stat = fs.statSync(path.join(CONFIG_FILES_DIR, f));
          files.push({ name: f, size: stat.size });
        }
      }
    }
    jsonResponse(res, { files });
  } catch (err: any) {
    jsonResponse(res, { error: err.message }, 500);
  }
}

function handleFileRead(res: http.ServerResponse, name: string): void {
  // Prevent traversal
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    jsonResponse(res, { error: 'Invalid filename' }, 400);
    return;
  }
  const filePath = path.join(CONFIG_FILES_DIR, name);
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    jsonResponse(res, { name, content });
  } catch {
    jsonResponse(res, { error: 'File not found' }, 404);
  }
}

function handleFileWrite(res: http.ServerResponse, name: string, body: string): void {
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    jsonResponse(res, { error: 'Invalid filename' }, 400);
    return;
  }
  try {
    const { content } = JSON.parse(body);
    if (typeof content !== 'string' || content.length > MAX_FILE_SIZE) {
      jsonResponse(res, { error: 'Content too large or invalid' }, 400);
      return;
    }
    const filePath = path.join(CONFIG_FILES_DIR, name);
    fs.writeFileSync(filePath, content, 'utf8');
    jsonResponse(res, { ok: true, name });
  } catch (err: any) {
    jsonResponse(res, { error: err.message }, 500);
  }
}
