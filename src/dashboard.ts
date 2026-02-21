/**
 * Dashboard HTTP server — serves plugin UIs and provides WebSocket for live updates.
 * Phase D of buhdi-node v0.3 programmable node spec.
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, saveConfig } from './config';

// ---- Types ----

export interface DashboardPlugin {
  name: string;
  assetsDir: string;
  description?: string;
  version: string;
}

// ---- Dashboard Data Store (cross-plugin) ----

/** Per-plugin data store: pluginName -> key -> value */
const pluginDataStore = new Map<string, Map<string, unknown>>();

export function setDashboardData(pluginName: string, key: string, value: unknown): void {
  let store = pluginDataStore.get(pluginName);
  if (!store) {
    store = new Map();
    pluginDataStore.set(pluginName, store);
  }
  store.set(key, value);
}

export function getDashboardData(
  requestingPlugin: string,
  targetPlugin: string,
  key: string,
  permissions: string[]
): unknown {
  // Same plugin can always read its own data
  if (requestingPlugin !== targetPlugin) {
    const required = `read:${targetPlugin}`;
    if (!permissions.includes(required)) {
      throw new Error(`Permission denied: ${requestingPlugin} needs "${required}" to read ${targetPlugin} data`);
    }
  }
  const store = pluginDataStore.get(targetPlugin);
  if (!store) return undefined;
  return store.get(key);
}

// ---- WebSocket broadcast ----

const MAX_WS_CLIENTS = 50;
let wsServer: WebSocketServer | null = null;
const wsClients = new Set<WebSocket>();

export function emitDashboardEvent(event: string, data: unknown): void {
  const message = JSON.stringify({ event, data, timestamp: Date.now() });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

// ---- Registered dashboard plugins ----

const dashboardPlugins = new Map<string, DashboardPlugin>();

export function registerDashboardPlugin(plugin: DashboardPlugin): void {
  dashboardPlugins.set(plugin.name, plugin);
}

export function unregisterDashboardPlugin(name: string): void {
  dashboardPlugins.delete(name);
  pluginDataStore.delete(name);
}

// ---- Auth ----

function ensureDashboardToken(): string {
  const config = loadConfig();
  if (config.dashboardToken) return config.dashboardToken;
  const token = crypto.randomBytes(32).toString('hex');
  config.dashboardToken = token;
  saveConfig(config);
  return token;
}

function isLocalRequest(req: http.IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  if (isLocalRequest(req)) return true;
  const auth = req.headers.authorization;
  return auth === `Bearer ${token}`;
}

// ---- MIME types ----

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// ---- Path traversal protection ----

function resolveStaticPath(assetsDir: string, requestedPath: string): string | null {
  const resolved = path.resolve(assetsDir, requestedPath);
  // Ensure resolved path stays within assetsDir
  if (!resolved.startsWith(path.resolve(assetsDir) + path.sep) && resolved !== path.resolve(assetsDir)) {
    return null;
  }
  return resolved;
}

// ---- Index page ----

function renderIndexPage(): string {
  const plugins = Array.from(dashboardPlugins.values());
  const pluginList = plugins.length > 0
    ? plugins.map(p =>
      `<li><a href="/${escapeHtml(p.name)}/">${escapeHtml(p.name)}</a> <small>v${escapeHtml(p.version)}${p.description ? ` — ${escapeHtml(p.description)}` : ''}</small></li>`
    ).join('\n        ')
    : '<li><em>No dashboard plugins installed</em></li>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Buhdi Node Dashboard</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #333; }
    h1 { font-size: 1.5rem; }
    ul { list-style: none; padding: 0; }
    li { padding: 0.5rem 0; border-bottom: 1px solid #eee; }
    a { color: #0066cc; text-decoration: none; font-weight: 500; }
    a:hover { text-decoration: underline; }
    small { color: #888; }
  </style>
</head>
<body>
  <h1>🐻 Buhdi Node Dashboard</h1>
  <p>Installed dashboard plugins:</p>
  <ul>
    ${pluginList}
  </ul>
  <p><small>WebSocket: <code>ws://localhost:PORT/ws</code></small></p>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- Server ----

export function startDashboardServer(port: number): http.Server | null {
  if (!port || port === 0) return null;

  const token = ensureDashboardToken();

  const server = http.createServer((req, res) => {
    if (!isAuthorized(req, token)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized — provide Bearer token' }));
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    // Security headers for all responses
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');

    // Root index
    if (pathname === '/' || pathname === '') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'",
      });
      res.end(renderIndexPage());
      return;
    }

    // Route: /<plugin-name>/...
    const parts = pathname.split('/').filter(Boolean);
    const pluginName = parts[0];
    const plugin = dashboardPlugins.get(pluginName);

    if (!plugin) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Plugin not found' }));
      return;
    }

    // Resolve file within plugin's assets dir
    const relativePath = parts.slice(1).join('/') || 'index.html';
    const filePath = resolveStaticPath(plugin.assetsDir, relativePath);

    if (!filePath) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden — path traversal detected' }));
      return;
    }

    // Serve the file
    fs.stat(filePath, (err, stats) => {
      if (err || !stats || !stats.isFile()) {
        // Try index.html for directory requests
        if (!stats || stats.isDirectory()) {
          const indexPath = resolveStaticPath(plugin.assetsDir, path.join(relativePath, 'index.html'));
          if (indexPath) {
            return serveFile(indexPath, res);
          }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
      }
      serveFile(filePath, res);
    });
  });

  // WebSocket upgrade on /ws
  wsServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // WARD-D1: Always require token for WebSocket (prevents CSWSH from malicious webpages)
    const wsAuth = req.headers.authorization || url.searchParams.get('token');
    const tokenMatch = wsAuth === `Bearer ${token}` || wsAuth === token;
    if (!tokenMatch) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // WARD-D4: Limit max WebSocket connections
    if (wsClients.size >= MAX_WS_CLIENTS) {
      socket.write('HTTP/1.1 503 Too Many Connections\r\n\r\n');
      socket.destroy();
      return;
    }

    wsServer!.handleUpgrade(req, socket, head, (ws) => {
      wsClients.add(ws);
      ws.on('close', () => wsClients.delete(ws));
      ws.on('error', () => wsClients.delete(ws));
    });
  });

  server.listen(port, '127.0.0.1', () => {
    // logged by caller
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`⚠️  Dashboard port ${port} already in use`);
    }
  });

  return server;
}

function serveFile(filePath: string, res: http.ServerResponse): void {
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }
    const mime = getMimeType(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': stats.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

/** Expose dashboard token in health endpoint (only from localhost) */
export function getDashboardToken(): string | undefined {
  const config = loadConfig();
  return config.dashboardToken;
}
