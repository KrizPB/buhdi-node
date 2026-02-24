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
let memoryWriteLog: Map<string, number[]> | null = null;

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
    // H3-FIX: Only accept Bearer header for API auth (no query string tokens for API endpoints)
    const authHeader = req.headers.authorization || '';
    const token = authHeader.replace(/^Bearer\s+/i, '') || '';
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

    // ---- LLM API ----
    if (pathname === '/api/llm/status' && req.method === 'GET') {
      try {
        const { llmRouter } = require('./llm');
        return jsonResponse(res, {
          providers: llmRouter.getHealthStatus(),
          stats: llmRouter.getStats(),
          available: llmRouter.hasAvailableProvider(),
        });
      } catch {
        return jsonResponse(res, { providers: [], stats: {}, available: false });
      }
    }

    if (pathname === '/api/llm/chat' && req.method === 'POST') {
      return readBody(req, async (body) => {
        try {
          const { message, history } = JSON.parse(body);
          const { llmRouter } = require('./llm');
          const { toolRegistry } = require('./tool-plugins');
          const { sanitizeHistory, sanitizeToolOutput, validateToolCall, MAX_TOOL_CALLS_PER_TURN } = require('./llm/safety');
          const { buildPersonaPrompt } = require('./persona');
          const { getRelevantContext } = require('./memory');

          // H6-FIX: Sanitize client history (only user/assistant, strip secrets)
          const safeHistory = sanitizeHistory(history);

          const tools = toolRegistry.getLLMToolSchemas();
          const toolDesc = tools.map((t: any) => `- ${t.function.name}: ${t.function.description}`).join('\n');
          const systemPrompt = await buildPersonaPrompt(toolDesc);

          // Pull relevant memory context for this specific message
          const memoryContext = getRelevantContext(message, 1500);

          const messages: any[] = [
            { role: 'system', content: systemPrompt + (memoryContext ? '\n\n' + memoryContext : '') },
            ...safeHistory,
            { role: 'user', content: message },
          ];

          const result = await llmRouter.complete({
            messages,
            tools: tools.length > 0 ? tools : undefined,
          });

          // H3-FIX: Cap tool calls per turn
          if (result.toolCalls.length > 0) {
            const cappedCalls = result.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
            const toolResults: any[] = [];

            for (const tc of cappedCalls) {
              // H2-FIX: Validate tool name against provided schemas
              if (!validateToolCall(tc.function.name, tools)) {
                toolResults.push({
                  tool_call_id: tc.id,
                  role: 'tool',
                  content: `Error: tool "${tc.function.name}" is not available.`,
                });
                continue;
              }

              let params: Record<string, any> = {};
              try { params = JSON.parse(tc.function.arguments); } catch {}
              const toolResult = await toolRegistry.executeByFullName(tc.function.name, params);

              // H1-FIX: Sanitize tool output before LLM re-injection
              toolResults.push({
                tool_call_id: tc.id,
                role: 'tool',
                content: sanitizeToolOutput(toolResult.output),
              });
            }

            const followUp = await llmRouter.complete({
              messages: [
                ...messages,
                { role: 'assistant', content: result.content, tool_calls: cappedCalls },
                ...toolResults,
              ],
            });

            jsonResponse(res, {
              content: followUp.content,
              provider: followUp.provider,
              model: followUp.model,
              latencyMs: result.latencyMs + followUp.latencyMs,
              toolsUsed: cappedCalls.map((tc: any) => tc.function.name),
            });
          } else {
            jsonResponse(res, {
              content: result.content,
              provider: result.provider,
              model: result.model,
              latencyMs: result.latencyMs,
              toolsUsed: [],
            });
          }
        } catch (err: any) {
          jsonResponse(res, { error: err.message, content: null }, 500);
        }
      });
    }

    if (pathname === '/api/llm/healthcheck' && req.method === 'POST') {
      (async () => {
        try {
          const { llmRouter } = require('./llm');
          await llmRouter.runHealthChecks();
          jsonResponse(res, { providers: llmRouter.getHealthStatus() });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      })();
      return;
    }

    // ---- Provider Management API ----
    if (pathname === '/api/providers' && req.method === 'GET') {
      try {
        const { loadConfig } = require('./config');
        const config = loadConfig();
        const providers = ((config as any).llm?.providers || []).map((p: any) => ({
          name: p.name,
          type: p.type || 'openai-compat',
          endpoint: p.endpoint,
          model: p.model,
          priority: p.priority || 1,
          maxContext: p.maxContext || 8192,
          enabled: p.enabled !== false,
          authType: p.authType || 'bearer',
          customHeader: p.customHeader,
          hasToken: !!(p.apiKey),
        }));
        const strategy = (config as any).llm?.strategy || 'local_first';
        return jsonResponse(res, { data: providers, strategy });
      } catch (err: any) {
        return jsonResponse(res, { data: [], strategy: 'local_first' });
      }
    }

    if (pathname === '/api/providers' && req.method === 'POST') {
      return readBody(req, (body) => {
        try {
          const { loadConfig, saveConfig } = require('./config');
          const input = JSON.parse(body);
          if (!input.name || !input.endpoint || !input.model) {
            return jsonResponse(res, { error: 'Missing name, endpoint, or model' }, 400);
          }
          if (input.name.length > 100) return jsonResponse(res, { error: 'Name too long' }, 400);

          const config = loadConfig();
          if (!(config as any).llm) (config as any).llm = {};
          if (!(config as any).llm.providers) (config as any).llm.providers = [];

          // Check duplicate name
          const existing = (config as any).llm.providers.findIndex((p: any) => p.name === input.name);

          const provider: any = {
            name: input.name,
            type: input.type || 'openai-compat',
            endpoint: input.endpoint,
            model: input.model,
            priority: input.priority || 1,
            capabilities: ['chat'],
            maxContext: input.maxContext || 8192,
            enabled: true,
            authType: input.authType || 'bearer',
            customHeader: input.customHeader,
          };

          // Store API key if provided
          if (input.token) {
            provider.apiKey = input.token;
          }

          if (existing >= 0) {
            // Update existing — preserve apiKey if not provided
            if (!input.token && (config as any).llm.providers[existing].apiKey) {
              provider.apiKey = (config as any).llm.providers[existing].apiKey;
            }
            (config as any).llm.providers[existing] = provider;
          } else {
            (config as any).llm.providers.push(provider);
          }

          saveConfig(config);
          addActivity('🤖', `Provider saved: ${input.name} (${input.model})`);

          // Reinitialize LLM router with new config
          import('./llm').then(({ initLLMRouter }) => initLLMRouter()).catch(() => {});

          jsonResponse(res, { ok: true, provider: { ...provider, apiKey: undefined, hasToken: !!provider.apiKey } }, existing >= 0 ? 200 : 201);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname?.startsWith('/api/providers/') && req.method === 'DELETE') {
      try {
        const name = decodeURIComponent(pathname.slice('/api/providers/'.length));
        const { loadConfig, saveConfig } = require('./config');
        const config = loadConfig();
        const providers = (config as any).llm?.providers || [];
        const idx = providers.findIndex((p: any) => p.name === name);
        if (idx === -1) return jsonResponse(res, { error: 'Not found' }, 404);
        providers.splice(idx, 1);
        saveConfig(config);
        addActivity('🗑️', `Provider removed: ${name}`);
        import('./llm').then(({ initLLMRouter }) => initLLMRouter()).catch(() => {});
        return jsonResponse(res, { ok: true });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname === '/api/providers/test' && req.method === 'POST') {
      return readBody(req, async (body) => {
        try {
          const input = JSON.parse(body);
          if (!input.endpoint || !input.model) {
            return jsonResponse(res, { error: 'Missing endpoint or model' }, 400);
          }

          // M1-FIX: Validate URL — block private/internal IPs
          try {
            const parsed = new URL(input.endpoint);
            const host = parsed.hostname.toLowerCase();
            // Allow localhost (for local LLMs) and public IPs
            const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '::1';
            const isPrivate = host.startsWith('10.') || host.startsWith('192.168.') || host.startsWith('169.254.')
              || host.startsWith('172.16.') || host.startsWith('172.17.') || host.startsWith('172.18.')
              || host.startsWith('172.19.') || host.startsWith('172.2') || host.startsWith('172.30.') || host.startsWith('172.31.')
              || host === '0.0.0.0' || host.endsWith('.local') || host.endsWith('.internal');
            if (isPrivate && !isLocal) {
              return jsonResponse(res, { ok: false, error: 'Private/internal network addresses blocked (except localhost)' });
            }
            if (!['http:', 'https:'].includes(parsed.protocol)) {
              return jsonResponse(res, { ok: false, error: 'Only http/https endpoints supported' });
            }
          } catch {
            return jsonResponse(res, { ok: false, error: 'Invalid endpoint URL' });
          }

          // M2-FIX: Validate customHeader name
          const BLOCKED_HEADERS = ['host', 'content-length', 'transfer-encoding', 'connection', 'cookie', 'set-cookie'];
          if (input.customHeader) {
            if (!/^[A-Za-z0-9-]+$/.test(input.customHeader)) {
              return jsonResponse(res, { ok: false, error: 'Invalid header name (alphanumeric and hyphens only)' });
            }
            if (BLOCKED_HEADERS.includes(input.customHeader.toLowerCase())) {
              return jsonResponse(res, { ok: false, error: 'Reserved header name not allowed' });
            }
          }

          const type = input.type || 'openai-compat';
          let testUrl: string;
          let headers: Record<string, string> = { 'Content-Type': 'application/json' };
          let testBody: string;

          // Auto-detect Anthropic: by type, endpoint, or token prefix
          const isAnthropic = type === 'anthropic' 
            || input.endpoint?.includes('api.anthropic.com')
            || input.token?.startsWith('sk-ant-oat');

          if (type === 'ollama') {
            testUrl = `${input.endpoint}/api/chat`;
            testBody = JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'Say "hello" in one word.' }], stream: false });
          } else if (isAnthropic) {
            // Anthropic native API — /v1/messages with special headers
            const endpoint = input.endpoint || 'https://api.anthropic.com';
            testUrl = `${endpoint}/v1/messages`;
            headers['anthropic-version'] = '2023-06-01';
            if (input.token?.startsWith('sk-ant-oat')) {
              headers['Authorization'] = `Bearer ${input.token}`;
              headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
              headers['anthropic-dangerous-direct-browser-access'] = 'true';
              headers['user-agent'] = 'buhdi-node/1.0 (local, api)';
            } else if (input.token) {
              headers['x-api-key'] = input.token;
            }
            testBody = JSON.stringify({ model: input.model, max_tokens: 10, messages: [{ role: 'user', content: 'Say "hello" in one word.' }] });
          } else {
            testUrl = `${input.endpoint}/v1/chat/completions`;
            if (input.token) {
              const authType = input.authType || 'bearer';
              if (authType === 'bearer') headers['Authorization'] = `Bearer ${input.token}`;
              else if (authType === 'x-api-key') headers['X-API-Key'] = input.token;
              else if (authType === 'api-key') headers['api-key'] = input.token;
              else if (authType === 'custom' && input.customHeader) headers[input.customHeader] = input.token;
            }
            testBody = JSON.stringify({ model: input.model, messages: [{ role: 'user', content: 'Say "hello" in one word.' }], max_tokens: 10 });
          }

          const resp = await fetch(testUrl, {
            method: 'POST',
            headers,
            body: testBody,
            signal: AbortSignal.timeout(15000),
          });

          if (!resp.ok) {
            const errText = await resp.text().catch(() => '');
            return jsonResponse(res, { ok: false, error: `${resp.status}: ${errText.substring(0, 200)}` });
          }

          const data = await resp.json() as any;
          const content = type === 'ollama'
            ? data?.message?.content
            : isAnthropic
              ? data?.content?.[0]?.text
              : data?.choices?.[0]?.message?.content;

          jsonResponse(res, { ok: true, response: content?.substring(0, 100) || 'Connected!', model: data?.model || input.model });
        } catch (err: any) {
          jsonResponse(res, { ok: false, error: err.message });
        }
      });
    }

    // Persona API
    if (pathname === '/api/persona' && req.method === 'GET') {
      const { getPersonaInfo } = require('./persona');
      return jsonResponse(res, getPersonaInfo());
    }

    // Debug prompt endpoint removed per Ward H2 — never expose assembled prompts

    if (pathname === '/api/memory/connect' && req.method === 'POST') {
      return readBody(req, async (body) => {
        try {
          const { api_key } = JSON.parse(body);
          if (!api_key) return jsonResponse(res, { ok: false, error: 'Missing api_key' }, 400);

          // Validate key against mybuhdi.com
          const check = await fetch('https://www.mybuhdi.com/api/memory/stats', {
            headers: { 'Authorization': `Bearer ${api_key}` },
            signal: AbortSignal.timeout(10000),
          });
          if (!check.ok) {
            return jsonResponse(res, { ok: false, error: `Invalid key (${check.status})` });
          }
          const stats = await check.json() as any;

          // Safely merge into config
          const { loadConfig, saveConfig } = require('./config');
          const config = loadConfig();
          if (!config.memory) config.memory = {};
          config.memory.sync = {
            enabled: true,
            cloud_url: 'https://www.mybuhdi.com',
            api_key,
            interval_seconds: 300,
          };
          saveConfig(config);

          jsonResponse(res, { 
            ok: true, 
            entities: stats.data?.entity_count ?? stats.entity_count ?? 0,
            message: 'Memory connected! Restart node to apply.' 
          });
        } catch (err: any) {
          jsonResponse(res, { ok: false, error: err.message });
        }
      });
    }

    if (pathname === '/api/persona/sync' && req.method === 'POST') {
      const { syncCloudPersona } = require('./persona');
      syncCloudPersona().then((result: any) => {
        jsonResponse(res, result);
      }).catch((err: any) => {
        jsonResponse(res, { ok: false, error: err.message }, 500);
      });
      return;
    }

    if (pathname === '/api/providers/strategy' && req.method === 'POST') {
      return readBody(req, (body) => {
        try {
          const { strategy } = JSON.parse(body);
          const VALID = ['local_first', 'cloud_first', 'local_only', 'cloud_only', 'cost_optimized'];
          if (!VALID.includes(strategy)) return jsonResponse(res, { error: 'Invalid strategy' }, 400);
          const { loadConfig, saveConfig } = require('./config');
          const config = loadConfig();
          if (!(config as any).llm) (config as any).llm = {};
          (config as any).llm.strategy = strategy;
          saveConfig(config);
          import('./llm').then(({ initLLMRouter }) => initLLMRouter()).catch(() => {});
          jsonResponse(res, { ok: true });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    // ---- Chat Sessions API ----
    if (pathname === '/api/chats' && req.method === 'GET') {
      try {
        const { listChats } = require('./chats');
        return jsonResponse(res, { data: listChats() });
      } catch (err: any) {
        return jsonResponse(res, { data: [] });
      }
    }

    if (pathname === '/api/chats' && req.method === 'POST') {
      return readBody(req, (body) => {
        try {
          const { createChat } = require('./chats');
          const { title } = body ? JSON.parse(body) : {};
          const chat = createChat(title);
          jsonResponse(res, { data: chat }, 201);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname?.startsWith('/api/chats/') && pathname.endsWith('/messages') && req.method === 'GET') {
      try {
        const id = pathname.slice('/api/chats/'.length).replace('/messages', '');
        const { getChatMessages } = require('./chats');
        return jsonResponse(res, { data: getChatMessages(id) });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname?.startsWith('/api/chats/') && pathname.endsWith('/messages') && req.method === 'POST') {
      return readBody(req, (body) => {
        try {
          const id = pathname!.slice('/api/chats/'.length).replace('/messages', '');
          const { addMessage } = require('./chats');
          const msg = JSON.parse(body);
          if (!msg.role || !msg.content) return jsonResponse(res, { error: 'Missing role or content' }, 400);
          if (!['user', 'assistant', 'system'].includes(msg.role)) return jsonResponse(res, { error: 'Invalid role' }, 400);
          if (msg.content.length > 50000) return jsonResponse(res, { error: 'Message too long (max 50000)' }, 400);
          msg.ts = msg.ts || new Date().toISOString();
          addMessage(id, msg);
          jsonResponse(res, { ok: true });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname?.startsWith('/api/chats/') && !pathname.includes('/messages') && req.method === 'PUT') {
      return readBody(req, (body) => {
        try {
          const id = pathname!.slice('/api/chats/'.length);
          const { updateChat } = require('./chats');
          const updates = JSON.parse(body);
          const chat = updateChat(id, updates);
          if (!chat) return jsonResponse(res, { error: 'Not found' }, 404);
          jsonResponse(res, { data: chat });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname?.startsWith('/api/chats/') && !pathname.includes('/messages') && req.method === 'DELETE') {
      try {
        const id = pathname.slice('/api/chats/'.length);
        const { deleteChat } = require('./chats');
        const ok = deleteChat(id);
        if (!ok) return jsonResponse(res, { error: 'Not found' }, 404);
        return jsonResponse(res, { ok: true });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ---- Wizard API ----
    if (pathname === '/api/wizard/status' && req.method === 'GET') {
      (async () => {
        try {
          const { runWizard } = require('./wizard');
          const status = await runWizard();
          jsonResponse(res, status);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      })();
      return;
    }

    if (pathname === '/api/wizard/auto-config' && req.method === 'POST') {
      (async () => {
        try {
          const { autoConfig } = require('./wizard');
          const result = await autoConfig();
          addActivity('🧙', `Auto-config: ${result.actions.join(', ')}`);
          jsonResponse(res, result);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      })();
      return;
    }

    // ---- Memory API ----
    // M2-FIX: Rate limiter for memory writes (100/min)
    const memoryRateKey = `mem_${req.socket.remoteAddress}`;
    if (!memoryWriteLog) memoryWriteLog = new Map();
    function checkMemoryRate(): boolean {
      const now = Date.now();
      const log = memoryWriteLog!.get(memoryRateKey) || [];
      const recent = log.filter((t: number) => now - t < 60000);
      if (recent.length >= 100) return false;
      recent.push(now);
      memoryWriteLog!.set(memoryRateKey, recent);
      return true;
    }
    if (pathname === '/api/memory/status' && req.method === 'GET') {
      try {
        const { getMemoryStatus } = require('./memory');
        const { getPersonaInfo } = require('./persona');
        const memStatus = getMemoryStatus();
        const persona = getPersonaInfo();
        const config = require('./config').loadConfig() as any;
        const cloudMemory = {
          connected: !!config.memory?.sync?.api_key,
          cloud_url: config.memory?.sync?.cloud_url || null,
          sync_enabled: config.memory?.sync?.enabled || false,
          cloud_cached: persona.cloudCached,
          last_sync: persona.cloudLastSync || null,
        };
        return jsonResponse(res, { ...memStatus, cloud: cloudMemory });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message, state: 'uninitialized' });
      }
    }

    if (pathname === '/api/memory/entities' && req.method === 'GET') {
      try {
        const { listEntities, isMemoryInitialized } = require('./memory');
        if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
        const params = new URL(req.url || '', 'http://localhost').searchParams;
        const q = params.get('q') || undefined;
        const limit = Math.min(parseInt(params.get('limit') || '50'), 200);
        const offset = parseInt(params.get('offset') || '0');
        const entities = listEntities('local', q, limit, offset);
        return jsonResponse(res, { data: entities });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname === '/api/memory/entities' && req.method === 'POST') {
      return readBody(req, async (body) => {
        try {
          const { createEntity, embedEntity, isMemoryInitialized } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          if (!checkMemoryRate()) return jsonResponse(res, { error: 'Rate limit exceeded (100/min)' }, 429);
          const input = JSON.parse(body);
          if (!input.name) return jsonResponse(res, { error: 'Missing name' }, 400);
          // L1-FIX: Input length limits
          if (input.name?.length > 500) return jsonResponse(res, { error: 'Name too long (max 500)' }, 400);
          if (input.description?.length > 5000) return jsonResponse(res, { error: 'Description too long (max 5000)' }, 400);
          const entity = createEntity('local', input);
          // Background embed (don't block response)
          embedEntity(entity.id).catch(() => {});
          addActivity('🧠', `Memory: stored entity "${entity.name}"`);
          jsonResponse(res, { data: entity }, 201);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname?.startsWith('/api/memory/entities/') && req.method === 'GET') {
      try {
        const { getEntity, isMemoryInitialized } = require('./memory');
        if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
        const id = pathname.slice('/api/memory/entities/'.length);
        const entity = getEntity(id);
        if (!entity) return jsonResponse(res, { error: 'Not found' }, 404);
        return jsonResponse(res, { data: entity });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname?.startsWith('/api/memory/entities/') && req.method === 'PUT') {
      return readBody(req, (body) => {
        try {
          const { updateEntity, embedEntity, isMemoryInitialized } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          const id = pathname!.slice('/api/memory/entities/'.length);
          const input = JSON.parse(body);
          const entity = updateEntity(id, input);
          if (!entity) return jsonResponse(res, { error: 'Not found' }, 404);
          embedEntity(entity.id).catch(() => {});
          jsonResponse(res, { data: entity });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname?.startsWith('/api/memory/entities/') && req.method === 'DELETE') {
      try {
        const { deleteEntity, isMemoryInitialized } = require('./memory');
        if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
        const id = pathname.slice('/api/memory/entities/'.length);
        const ok = deleteEntity(id);
        if (!ok) return jsonResponse(res, { error: 'Not found' }, 404);
        addActivity('🧠', `Memory: deleted entity ${id}`);
        return jsonResponse(res, { ok: true });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname === '/api/memory/facts' && req.method === 'POST') {
      return readBody(req, async (body) => {
        try {
          const { createFact, storeEmbedding, isMemoryInitialized, getDb } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          if (!checkMemoryRate()) return jsonResponse(res, { error: 'Rate limit exceeded (100/min)' }, 429);
          const input = JSON.parse(body);
          if (!input.entity_id || !input.key || !input.value) {
            return jsonResponse(res, { error: 'Missing entity_id, key, or value' }, 400);
          }
          if (input.key?.length > 500) return jsonResponse(res, { error: 'Key too long (max 500)' }, 400);
          if (input.value?.length > 10000) return jsonResponse(res, { error: 'Value too long (max 10000)' }, 400);
          const fact = createFact('local', input);
          // Embed the fact
          const entity = getDb().prepare('SELECT name FROM entities WHERE id = ?').get(input.entity_id) as any;
          if (entity) {
            storeEmbedding('facts', fact.id, `${entity.name}: ${fact.key} = ${fact.value}`).catch(() => {});
          }
          jsonResponse(res, { data: fact }, 201);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname === '/api/memory/relationships' && req.method === 'POST') {
      return readBody(req, (body) => {
        try {
          const { createRelationship, isMemoryInitialized } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          if (!checkMemoryRate()) return jsonResponse(res, { error: 'Rate limit exceeded (100/min)' }, 429);
          const input = JSON.parse(body);
          if (!input.source_entity_id || !input.target_entity_id || !input.relationship_type) {
            return jsonResponse(res, { error: 'Missing source_entity_id, target_entity_id, or relationship_type' }, 400);
          }
          const rel = createRelationship('local', input);
          jsonResponse(res, { data: rel }, 201);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname === '/api/memory/insights' && req.method === 'POST') {
      return readBody(req, async (body) => {
        try {
          const { createInsight, embedInsight, isMemoryInitialized } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          if (!checkMemoryRate()) return jsonResponse(res, { error: 'Rate limit exceeded (100/min)' }, 429);
          const input = JSON.parse(body);
          if (!input.content) return jsonResponse(res, { error: 'Missing content' }, 400);
          if (input.content?.length > 10000) return jsonResponse(res, { error: 'Content too long (max 10000)' }, 400);
          const insight = createInsight('local', input);
          embedInsight(insight.id).catch(() => {});
          jsonResponse(res, { data: insight }, 201);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname === '/api/memory/search' && req.method === 'GET') {
      (async () => {
        try {
          const { semanticSearch, isMemoryInitialized } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          const params = new URL(req.url || '', 'http://localhost').searchParams;
          const query = params.get('q') || params.get('query') || '';
          if (!query) return jsonResponse(res, { error: 'Missing q parameter' }, 400);
          const limit = Math.min(parseInt(params.get('limit') || '10'), 50);
          const minScore = parseFloat(params.get('min_score') || '0.3');
          const results = await semanticSearch(query, { limit, minScore });
          jsonResponse(res, { data: results, query });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      })();
      return;
    }

    if (pathname === '/api/memory/context' && req.method === 'GET') {
      (async () => {
        try {
          const { contextSearch, isMemoryInitialized } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          const params = new URL(req.url || '', 'http://localhost').searchParams;
          const query = params.get('q') || params.get('query') || '';
          if (!query) return jsonResponse(res, { error: 'Missing q parameter' }, 400);
          const limit = Math.min(parseInt(params.get('limit') || '5'), 20);
          const result = await contextSearch(query, { limit });
          jsonResponse(res, { data: result });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      })();
      return;
    }

    if (pathname === '/api/memory/reindex' && req.method === 'POST') {
      (async () => {
        try {
          const { reindexAll, isMemoryInitialized } = require('./memory');
          if (!isMemoryInitialized()) return jsonResponse(res, { error: 'Memory not initialized' }, 503);
          addActivity('🧠', 'Memory: reindexing all embeddings...');
          const result = await reindexAll();
          addActivity('🧠', `Memory: reindex complete — ${result.embedded} embeddings (${result.errors} errors)`);
          jsonResponse(res, { data: result });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      })();
      return;
    }

    // ---- Scheduler API ----
    if (pathname === '/api/schedules' && req.method === 'GET') {
      try {
        const { listSchedules } = require('./scheduler');
        return jsonResponse(res, { data: listSchedules() });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname === '/api/schedules' && req.method === 'POST') {
      return readBody(req, (body) => {
        try {
          const { createSchedule } = require('./scheduler');
          const input = JSON.parse(body);
          if (!input.name || !input.cron || !input.action) {
            return jsonResponse(res, { error: 'Missing name, cron, or action' }, 400);
          }
          if (input.name.length > 200) return jsonResponse(res, { error: 'Name too long (max 200)' }, 400);
          const schedule = createSchedule(input);
          addActivity('⏰', `Schedule created: ${schedule.name}`);
          jsonResponse(res, { data: schedule }, 201);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 400);
        }
      });
    }

    if (pathname?.startsWith('/api/schedules/') && req.method === 'GET') {
      try {
        const id = pathname.slice('/api/schedules/'.length).split('/')[0];
        const { getSchedule } = require('./scheduler');
        const schedule = getSchedule(id);
        if (!schedule) return jsonResponse(res, { error: 'Not found' }, 404);
        return jsonResponse(res, { data: schedule });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname?.startsWith('/api/schedules/') && req.method === 'PUT') {
      return readBody(req, (body) => {
        try {
          const id = pathname!.slice('/api/schedules/'.length).split('/')[0];
          const { updateSchedule } = require('./scheduler');
          const input = JSON.parse(body);
          const schedule = updateSchedule(id, input);
          if (!schedule) return jsonResponse(res, { error: 'Not found' }, 404);
          jsonResponse(res, { data: schedule });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 400);
        }
      });
    }

    if (pathname?.startsWith('/api/schedules/') && pathname.endsWith('/run') && req.method === 'POST') {
      (async () => {
        try {
          const id = pathname!.slice('/api/schedules/'.length).replace('/run', '');
          const { runScheduleNow } = require('./scheduler');
          const result = await runScheduleNow(id);
          jsonResponse(res, { data: result });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 400);
        }
      })();
      return;
    }

    if (pathname?.startsWith('/api/schedules/') && req.method === 'DELETE') {
      try {
        const id = pathname.slice('/api/schedules/'.length);
        const { deleteSchedule } = require('./scheduler');
        const ok = deleteSchedule(id);
        if (!ok) return jsonResponse(res, { error: 'Not found' }, 404);
        addActivity('🗑️', `Schedule deleted: ${id}`);
        return jsonResponse(res, { ok: true });
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    if (pathname === '/api/scheduler/status' && req.method === 'GET') {
      try {
        const { getSchedulerStatus } = require('./scheduler');
        return jsonResponse(res, getSchedulerStatus());
      } catch (err: any) {
        return jsonResponse(res, { error: err.message }, 500);
      }
    }

    // ---- Agent API ----
    if (pathname === '/api/agent/run' && req.method === 'POST') {
      return readBody(req, async (body) => {
        try {
          const { goal, config } = JSON.parse(body);
          if (!goal || typeof goal !== 'string') {
            return jsonResponse(res, { error: 'Missing goal' }, 400);
          }
          const { runAgent } = require('./agent');
          const run = await runAgent(goal, config);
          jsonResponse(res, run);
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname === '/api/agent/cancel' && req.method === 'POST') {
      return readBody(req, (body) => {
        try {
          const { runId } = JSON.parse(body);
          const { cancelAgent } = require('./agent');
          const ok = cancelAgent(runId);
          jsonResponse(res, { ok, runId });
        } catch (err: any) {
          jsonResponse(res, { error: err.message }, 500);
        }
      });
    }

    if (pathname === '/api/agent/active' && req.method === 'GET') {
      const { getActiveRuns } = require('./agent');
      return jsonResponse(res, { runs: getActiveRuns() });
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
            handleWSChat(data.message, data.history || [], ws);
          }
          addActivity('💬', `Chat: "${data.message.substring(0, 50)}"`);
        }
        if (data.type === 'agent.run' && data.goal) {
          handleWSAgentRun(data.goal, data.config || {}, ws);
        }
        if (data.type === 'agent.cancel' && data.runId) {
          const { cancelAgent } = require('./agent');
          cancelAgent(data.runId);
          ws.send(JSON.stringify({ type: 'agent.cancelled', runId: data.runId }));
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

// ---- WebSocket Chat → LLM ----
async function handleWSChat(message: string, history: any[], ws: import('ws').WebSocket): Promise<void> {
  try {
    const { llmRouter } = require('./llm');
    if (!llmRouter.hasAvailableProvider()) {
      ws.send(JSON.stringify({
        type: 'chat.message',
        role: 'assistant',
        content: 'No AI engine connected. Install [Ollama](https://ollama.com) and run `ollama pull llama3.1:8b`, or configure a cloud provider in Settings.',
        ts: new Date().toISOString(),
      }));
      return;
    }

    const { toolRegistry } = require('./tool-plugins');
    const { sanitizeHistory } = require('./llm/safety');
    const { buildPersonaPrompt } = require('./persona');
    const { getRelevantContext } = require('./memory');
    const tools = toolRegistry.getLLMToolSchemas();

    // H6-FIX: Sanitize client history
    const safeHistory = sanitizeHistory(history);

    const toolDesc = tools.map((t: any) => `- ${t.function.name}: ${t.function.description}`).join('\n');
    const systemPrompt = await buildPersonaPrompt(toolDesc);

    // Pull relevant memory for this specific message
    const memoryContext = getRelevantContext(message, 1500);

    const messages = [
      { role: 'system', content: systemPrompt + (memoryContext ? '\n\n' + memoryContext : '') },
      ...safeHistory,
      { role: 'user', content: message },
    ];

    // Stream response
    let fullContent = '';
    await llmRouter.stream(
      { messages, tools: tools.length > 0 ? tools : undefined },
      {
        onToken: (token: string) => {
          fullContent += token;
          ws.send(JSON.stringify({ type: 'chat.stream', token }));
        },
        onToolCall: async (tc: any) => {
          ws.send(JSON.stringify({
            type: 'chat.tool_call',
            tool: tc.function.name,
            args: tc.function.arguments,
          }));
        },
        onDone: (response: any) => {
          if (response.toolCalls?.length > 0) {
            // Execute tools and get final response
            handleToolCallsAndRespond(messages, fullContent, response, ws);
          } else {
            ws.send(JSON.stringify({
              type: 'chat.stream.end',
              full_text: fullContent,
              provider: response.provider,
              model: response.model,
            }));
          }
        },
        onError: (err: Error) => {
          ws.send(JSON.stringify({
            type: 'chat.message',
            role: 'assistant',
            content: `AI error: ${err.message}`,
            ts: new Date().toISOString(),
          }));
        },
      }
    );
  } catch (err: any) {
    ws.send(JSON.stringify({
      type: 'chat.message',
      role: 'assistant',
      content: `Error: ${err.message}`,
      ts: new Date().toISOString(),
    }));
  }
}

async function handleToolCallsAndRespond(
  messages: any[], assistantContent: string, response: any, ws: import('ws').WebSocket
): Promise<void> {
  try {
    const { llmRouter } = require('./llm');
    const { toolRegistry } = require('./tool-plugins');
    const { sanitizeToolOutput, validateToolCall, MAX_TOOL_CALLS_PER_TURN } = require('./llm/safety');

    // H3-FIX: Cap tool calls
    const cappedCalls = response.toolCalls.slice(0, MAX_TOOL_CALLS_PER_TURN);
    const tools = toolRegistry.getLLMToolSchemas();

    const toolResults: any[] = [];
    for (const tc of cappedCalls) {
      // H2-FIX: Validate tool name
      if (!validateToolCall(tc.function.name, tools)) {
        toolResults.push({
          tool_call_id: tc.id,
          role: 'tool',
          content: `Error: tool "${tc.function.name}" is not available.`,
        });
        continue;
      }

      let params: Record<string, any> = {};
      try { params = JSON.parse(tc.function.arguments); } catch {}

      ws.send(JSON.stringify({
        type: 'chat.tool_executing',
        tool: tc.function.name,
      }));

      const result = await toolRegistry.executeByFullName(tc.function.name, params);

      // H1-FIX: Sanitize tool output
      const sanitizedOutput = sanitizeToolOutput(result.output);
      toolResults.push({
        tool_call_id: tc.id,
        role: 'tool',
        content: sanitizedOutput,
      });

      ws.send(JSON.stringify({
        type: 'chat.tool_result',
        tool: tc.function.name,
        success: result.success,
        output: sanitizedOutput.substring(0, 200),
      }));
    }

    const followUp = await llmRouter.complete({
      messages: [
        ...messages,
        { role: 'assistant', content: assistantContent, tool_calls: cappedCalls },
        ...toolResults,
      ],
    });

    ws.send(JSON.stringify({
      type: 'chat.message',
      role: 'assistant',
      content: followUp.content || 'Tool executed but no response generated.',
      ts: new Date().toISOString(),
      provider: followUp.provider,
      model: followUp.model,
      toolsUsed: cappedCalls.map((tc: any) => tc.function.name),
    }));
  } catch (err: any) {
    ws.send(JSON.stringify({
      type: 'chat.message',
      role: 'assistant',
      content: `Tool execution error: ${err.message}`,
      ts: new Date().toISOString(),
    }));
  }
}

// ---- WebSocket Agent Run ----
async function handleWSAgentRun(goal: string, config: any, ws: import('ws').WebSocket): Promise<void> {
  // F6-FIX: Safe send that checks readyState
  const wsSend = (data: any) => {
    if (ws.readyState === 1 /* OPEN */) {
      ws.send(JSON.stringify(data));
    }
  };

  try {
    const { runAgent } = require('./agent');

    const run = await runAgent(goal, config, {
      onStep: (step: any, run: any) => {
        wsSend({
          type: 'agent.step',
          runId: run.id,
          step: {
            index: step.index,
            thought: step.thought,
            action: step.action,
            observation: step.observation?.substring(0, 500),
            durationMs: step.durationMs,
          },
        });
      },
      onToolCall: (tool: string, params: any) => {
        wsSend({ type: 'agent.tool_call', tool, params });
      },
      onToolResult: (tool: string, result: any) => {
        wsSend({
          type: 'agent.tool_result',
          tool,
          success: result.success,
          output: (result.output || '').substring(0, 300),
        });
      },
      onThinking: (thought: string) => {
        wsSend({ type: 'agent.thinking', thought });
      },
      onComplete: (run: any) => {
        wsSend({
          type: 'agent.complete',
          runId: run.id,
          status: run.status,
          result: run.result,
          steps: run.steps.length,
          toolsUsed: run.toolsUsed,
          durationMs: run.totalDurationMs,
        });
      },
      onError: (err: Error, run: any) => {
        wsSend({
          type: 'agent.error',
          runId: run.id,
          error: err.message,
        });
      },
    });
  } catch (err: any) {
    wsSend({
      type: 'agent.error',
      error: err.message,
    });
  }
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
