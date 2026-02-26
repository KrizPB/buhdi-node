import { TaskExecutor, Task } from './executor';
import WebSocket from 'ws';
import { ensureKeypair, getPublicKey, syncVaultForNewNodes, decryptVaultSecret } from './vault';
import { setPluginSecret, deletePluginSecret, listPluginSecrets } from './plugins/plugin-vault';
import { updateHealthState } from './health';
import { EventEmitter } from 'events';
import { PluginManager } from './plugins/manager';
import { fetchDeployKey, loadDeployKey } from './plugins/signing';
import { loadConfig } from './config';
import { detectCapabilities } from './capabilities';
import crypto from 'crypto';

const BASE_URL = 'https://www.mybuhdi.com';
const WS_URL = 'wss://buhdi-ws.fly.dev/ws';
const POLL_INTERVAL = 5000;
const HEARTBEAT_INTERVAL = 60000;

// ---- Tool Sync State ----
let lastToolSyncHash = '';

async function syncToolsToCloud(apiKey: string, nodeId: string): Promise<void> {
  try {
    const config = loadConfig();
    const tools = (config as any).customTools || [];
    if (tools.length === 0) {
      if (lastToolSyncHash) {
        // Tools were deleted — sync empty list
        lastToolSyncHash = '';
        await fetch(`${BASE_URL}/api/node/tools/sync`, {
          method: 'POST',
          headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ node_id: nodeId, tools: [] }),
        });
      }
      return;
    }
    const hash = crypto.createHash('md5').update(JSON.stringify(tools.map((t: any) => t.name + t.desc))).digest('hex');
    if (hash === lastToolSyncHash) return; // No changes
    const syncPayload = tools.map((t: any) => ({
      name: t.name,
      description: t.desc || t.displayName || t.name,
      category: t.category || 'Custom',
      credentials_required: t.authType !== 'none',
    }));
    const resp = await fetch(`${BASE_URL}/api/node/tools/sync`, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ node_id: nodeId, tools: syncPayload }),
    });
    if (resp.ok) lastToolSyncHash = hash;
  } catch { /* silent — don't break heartbeat */ }
}

export function triggerToolSync(apiKey: string, nodeId: string): void {
  lastToolSyncHash = ''; // Force re-sync on next heartbeat
  syncToolsToCloud(apiKey, nodeId).catch(() => {});
}

// ---- Connection State Machine ----
export enum ConnectionState {
  DISCONNECTED = 'DISCONNECTED',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  RECONNECTING = 'RECONNECTING',
  POLLING = 'POLLING',
}

// Backoff config
const BACKOFF_BASE = 1000;
const BACKOFF_CAP = 60000;
const BACKOFF_JITTER = 500;

// Ping/pong stale detection
const PING_INTERVAL = 25000;
const PONG_TIMEOUT = 10000;

// Polling fallback threshold
const WS_FAILURE_THRESHOLD = 5;

// Internal watchdog
const WATCHDOG_CHECK_INTERVAL = 10 * 60 * 1000; // 10 minutes
const WATCHDOG_STALE_THRESHOLD = 15 * 60 * 1000; // 15 minutes without successful activity = stale (was 5m, too aggressive for idle nodes)
const WATCHDOG_MAX_UPTIME = 24 * 60 * 60 * 1000; // 24 hours — clean restart (was 6h, too frequent)

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class NodeConnection extends EventEmitter {
  private apiKey: string;
  private nodeId: string | null = null;
  private nodeName: string = 'Unknown';
  private running = false;
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private reconnectDelay = BACKOFF_BASE;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _memorySyncCounter = 0;
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private executor: TaskExecutor | null = null;
  private polling = false;
  private lastTaskAt: string | null = null;
  private pluginManager: PluginManager | null = null;

  // v0.2 additions
  private _state: ConnectionState = ConnectionState.DISCONNECTED;
  private wsFailureCount = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private awaitingPong = false;

  // Internal watchdog
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private lastSuccessfulPoll: number = Date.now();
  private startedAt: number = Date.now();
  private pendingPeerRequests: Map<string, { resolve: (value: any) => void; reject: (reason: any) => void; timeout: NodeJS.Timeout }> = new Map();

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get name(): string {
    return this.nodeName;
  }

  get id(): string | null {
    return this.nodeId;
  }

  get connected(): boolean {
    return this.wsConnected;
  }

  setPluginManager(pm: PluginManager): void {
    this.pluginManager = pm;
  }

  private setState(newState: ConnectionState): void {
    if (this._state === newState) return;
    const old = this._state;
    this._state = newState;
    this.emit('stateChange', newState, old);
    updateHealthState({
      connectionState: newState,
      wsConnected: newState === ConnectionState.CONNECTED,
      nodeId: this.nodeId,
      nodeName: this.nodeName,
    });
  }

  async connect(systemInfo: any, software: string[]): Promise<void> {
    this.setState(ConnectionState.CONNECTING);
    const res = await fetch(`${BASE_URL}/api/node/connect`, {
      method: 'POST',
      headers: {
        'x-node-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ system_info: systemInfo, capabilities: software }),
    });

    if (!res.ok) {
      const text = await res.text();
      this.setState(ConnectionState.DISCONNECTED);
      throw new Error(`Connection failed (${res.status}): ${text}`);
    }

    const data = await res.json() as any;
    this.nodeId = data.data?.node_id || data.node_id;
    this.nodeName = data.data?.node_name || data.node_name || 'Unknown';

    // Ensure vault keypair exists and upload public key
    try {
      await ensureKeypair();
      const publicKey = getPublicKey();
      await fetch(`${BASE_URL}/api/node/vault/key`, {
        method: 'POST',
        headers: {
          'x-node-key': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ public_key: publicKey, algorithm: 'RSA-OAEP-4096' }),
      });
      console.log('🔐 Vault public key uploaded');

      try {
        const synced = await syncVaultForNewNodes(this.apiKey, BASE_URL);
        if (synced > 0) console.log(`🔄 Synced ${synced} vault key(s) for other nodes`);
      } catch (err: any) {
        console.warn('⚠️  Vault sync check failed:', err.message);
      }
    } catch (err: any) {
      console.warn('⚠️  Vault key upload failed:', err.message);
    }
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await fetch(`${BASE_URL}/api/node/heartbeat`, {
          method: 'POST',
          headers: {
            'x-node-key': this.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            node_id: this.nodeId,
            dashboard_url: (() => {
              try {
                const cfg = loadConfig();
                const port = cfg.healthPort || 9847;
                const token = cfg.dashboardToken || '';
                return token ? `http://localhost:${port}/?token=${token}` : `http://localhost:${port}/`;
              } catch { return undefined; }
            })(),
          }),
        });
        // Sync custom tools to cloud after successful heartbeat
        if (this.nodeId) await syncToolsToCloud(this.apiKey, this.nodeId);
        // Push dirty memory to cloud every 5th heartbeat (~5 min at 60s interval)
        if (!this._memorySyncCounter) this._memorySyncCounter = 0;
        this._memorySyncCounter++;
        if (this._memorySyncCounter % 5 === 0) {
          try {
            const { pushToCloud } = await import('./memory/index');
            await pushToCloud(BASE_URL, this.apiKey);
          } catch { /* silent */ }
        }
      } catch { /* silent */ }
    }, HEARTBEAT_INTERVAL);
  }

  async startListening(executor: TaskExecutor): Promise<void> {
    this.executor = executor;
    executor.setApiKey(this.apiKey);
    this.running = true;
    this.startWatchdog();
    this.connectWebSocket();
    while (this.running) {
      await sleep(1000);
    }
  }

  // ---- Polling ----

  private startPolling(): void {
    if (this.polling || !this.running) return;
    this.polling = true;
    this.setState(ConnectionState.POLLING);
    console.log('🔄 Polling for tasks (WebSocket offline)...');
    this.pollLoop();
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollLoop(): Promise<void> {
    if (!this.polling || !this.running || !this.executor) return;

    try {
      const tasks = await this.fetchTasks();
      this.lastSuccessfulPoll = Date.now(); // Watchdog: poll succeeded
      for (const task of tasks) {
        console.log(`🔧 Task: [${task.type}] ${task.payload?.command || task.payload?.path || ''}`);
        this.lastTaskAt = new Date().toISOString();
        updateHealthState({ lastTaskAt: this.lastTaskAt });
        const result = await this.executor.execute(task);
        await this.reportResult(task.id, result);
      }
    } catch (err: any) {
      if (!err?.message?.includes('fetch')) {
        console.error('⚠️  Poll error:', err?.message || err);
      }
    }

    if (this.polling && this.running) {
      this.pollTimer = setTimeout(() => this.pollLoop(), POLL_INTERVAL);
    }
  }

  // ---- WebSocket ----

  private connectWebSocket(): void {
    this.setState(this.wsFailureCount > 0 ? ConnectionState.RECONNECTING : ConnectionState.CONNECTING);
    console.log('🔌 Connecting via WebSocket...');

    try {
      this.ws = new WebSocket(`${WS_URL}?key=${encodeURIComponent(this.apiKey)}`);
    } catch (err: any) {
      console.error('❌ WebSocket creation failed:', err.message);
      this.onWsFailure();
      return;
    }

    this.ws.on('open', () => {
      // Auth is via query param, no message needed
      // Server sends 'welcome' on successful auth
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleWsMessage(msg);
      } catch {
        console.error('⚠️  Invalid WS message:', raw.toString().slice(0, 100));
      }
    });

    this.ws.on('close', (code: number) => {
      const wasConnected = this.wsConnected;
      this.wsConnected = false;
      this.stopPingPong();

      if (wasConnected) {
        console.log(`🔌 WebSocket disconnected (${code})`);
      }

      if (this.running) {
        this.onWsFailure();
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('⚠️  WebSocket error:', err.message);
    });

    this.ws.on('pong', () => {
      this.awaitingPong = false;
      this.lastSuccessfulPoll = Date.now(); // Pong = connection alive, don't let watchdog kill it
      if (this.pongTimer) {
        clearTimeout(this.pongTimer);
        this.pongTimer = null;
      }
    });
  }

  private onWsFailure(): void {
    this.wsFailureCount++;
    this.stopWsHeartbeat();

    if (this.wsFailureCount >= WS_FAILURE_THRESHOLD) {
      // Switch to polling mode, but keep trying WS in background
      this.startPolling();
    } else if (!this.polling) {
      this.startPolling();
    }

    this.scheduleReconnect();
  }

  private handleWsMessage(msg: any): void {
    switch (msg.type) {
      case 'welcome':
        this.wsConnected = true;
        this.wsFailureCount = 0;
        this.reconnectDelay = BACKOFF_BASE;
        this.nodeName = msg.nodeName || this.nodeName;
        this.nodeId = msg.nodeId || this.nodeId;
        this.setState(ConnectionState.CONNECTED);
        this.lastSuccessfulPoll = Date.now(); // Watchdog: WS connected = alive
        console.log(`✅ WebSocket connected as "${this.nodeName}"`);
        this.startWsHeartbeat();
        this.startPingPong();
        // Fetch deploy key if not cached
        if (!loadDeployKey()) {
          fetchDeployKey(this.apiKey).catch(() => {});
        }
        if (this.polling) {
          console.log('📡 WebSocket restored — polling disabled');
          this.stopPolling();
        }
        break;

      case 'ping':
        this.wsSend({ type: 'pong' });
        this.lastSuccessfulPoll = Date.now(); // Server ping = connection alive
        break;

      case 'task':
        this.handleWsTask(msg.task);
        break;

      case 'DEPLOY_TOOL':
        this.handleDeployTool(msg).catch(err => console.error('DEPLOY_TOOL error:', err.message));
        break;

      case 'START_TOOL':
        this.handleStartTool(msg).catch(err => console.error('START_TOOL error:', err.message));
        break;

      case 'STOP_TOOL':
        this.handleStopTool(msg).catch(err => console.error('STOP_TOOL error:', err.message));
        break;

      case 'UNINSTALL_TOOL':
        this.handleUninstallTool(msg).catch(err => console.error('UNINSTALL_TOOL error:', err.message));
        break;

      case 'TOOL_STATUS':
        this.handleToolStatus();
        break;

      case 'SET_SECRET':
        this.handleSetSecret(msg).catch(err => console.error('SET_SECRET error:', err.message));
        break;

      case 'DELETE_SECRET':
        this.handleDeleteSecret(msg).catch(err => console.error('DELETE_SECRET error:', err.message));
        break;

      case 'LIST_SECRETS':
        this.handleListSecrets(msg).catch(err => console.error('LIST_SECRETS error:', err.message));
        break;

      case 'APPROVE_TOOL':
        this.handleApproveTool(msg).catch(err => console.error('APPROVE_TOOL error:', err.message));
        break;

      case 'REJECT_TOOL':
        this.handleRejectTool(msg).catch(err => console.error('REJECT_TOOL error:', err.message));
        break;

      case 'SOFTWARE_UPDATE':
        // Handled via self_update task in executor — WS path only acks
        console.log(`📦 SOFTWARE_UPDATE received (version: ${msg.version || 'latest'}) — will process via task`);
        this.wsSend({ type: 'UPDATE_ACK', status: 'received', version: this.getCurrentVersion() });
        break;

      case 'CHECK_VERSION':
        this.handleCheckVersion();
        break;

      case 'peer_task': {
        const PEER_ALLOWED_TYPES = ['shell', 'read_file', 'list_files', 'status', 'screenshot', 'file_read', 'system_info', 'build_webpage'];
        const { from_node, request_id, task: peerTask } = msg;
        console.log(`📥 Peer task from ${from_node}: ${peerTask?.type}`);
        this.lastSuccessfulPoll = Date.now();
        if (peerTask && !PEER_ALLOWED_TYPES.includes(peerTask.type)) {
          console.warn(`⚠️ Rejected peer task type: ${peerTask.type}`);
          this.wsSend({ type: 'peer_result', target_node: from_node, request_id, result: { status: 'failed', error: `Task type '${peerTask.type}' not allowed for peer execution` } });
          break;
        }
        if (this.executor && peerTask) {
          this.executor.execute({ ...peerTask, id: request_id }).then((result) => {
            this.wsSend({
              type: 'peer_result',
              target_node: from_node,
              request_id,
              result,
            });
          }).catch((err: any) => {
            this.wsSend({
              type: 'peer_result',
              target_node: from_node,
              request_id,
              result: { status: 'failed', error: err.message },
            });
          });
        }
        break;
      }

      case 'peer_result': {
        const { request_id, result } = msg;
        this.lastSuccessfulPoll = Date.now();
        const pending = this.pendingPeerRequests.get(request_id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingPeerRequests.delete(request_id);
          pending.resolve(result);
        }
        break;
      }

      default:
        break;
    }
  }

  // ---- Plugin command handlers ----

  private async handleDeployTool(msg: any): Promise<void> {
    if (!this.pluginManager) return;
    const { manifest, codeBundle, signature, nonce, codeHash } = msg;
    try {
      const result = await this.pluginManager.installPlugin(manifest, codeBundle, {
        signature,
        nonce,
        codeHash,
      });

      if (result.status === 'pending') {
        this.wsSend({
          type: 'DEPLOY_PENDING',
          toolId: manifest.name,
          version: manifest.version,
          message: result.message,
        });
      } else {
        this.wsSend({ type: 'DEPLOY_ACK', toolId: manifest.name, version: manifest.version });
      }
    } catch (err: any) {
      this.wsSend({ type: 'DEPLOY_ERROR', toolId: manifest?.name, error: err.message });
    }
  }

  private async handleApproveTool(msg: any): Promise<void> {
    if (!this.pluginManager) return;
    try {
      await this.pluginManager.approvePlugin(msg.toolId);
      const info = this.pluginManager.getPlugin(msg.toolId);
      this.wsSend({ type: 'DEPLOY_ACK', toolId: msg.toolId, version: info?.version });
    } catch (err: any) {
      this.wsSend({ type: 'DEPLOY_ERROR', toolId: msg.toolId, error: err.message });
    }
  }

  private async handleRejectTool(msg: any): Promise<void> {
    if (!this.pluginManager) return;
    try {
      await this.pluginManager.rejectPlugin(msg.toolId);
      this.wsSend({ type: 'REJECT_ACK', toolId: msg.toolId });
    } catch (err: any) {
      this.wsSend({ type: 'REJECT_ERROR', toolId: msg.toolId, error: err.message });
    }
  }

  private async handleStartTool(msg: any): Promise<void> {
    if (!this.pluginManager) return;
    try {
      await this.pluginManager.startPlugin(msg.toolId);
      const info = this.pluginManager.getPlugin(msg.toolId);
      this.wsSend({ type: 'TOOL_STATUS', toolId: msg.toolId, status: info?.status });
    } catch (err: any) {
      this.wsSend({ type: 'TOOL_STATUS', toolId: msg.toolId, status: 'error', error: err.message });
    }
  }

  private async handleStopTool(msg: any): Promise<void> {
    if (!this.pluginManager) return;
    try {
      await this.pluginManager.stopPlugin(msg.toolId);
      const info = this.pluginManager.getPlugin(msg.toolId);
      this.wsSend({ type: 'TOOL_STATUS', toolId: msg.toolId, status: info?.status });
    } catch (err: any) {
      this.wsSend({ type: 'TOOL_STATUS', toolId: msg.toolId, status: 'error', error: err.message });
    }
  }

  private async handleUninstallTool(msg: any): Promise<void> {
    if (!this.pluginManager) return;
    try {
      await this.pluginManager.uninstallPlugin(msg.toolId);
      this.wsSend({ type: 'UNINSTALL_ACK', toolId: msg.toolId });
    } catch (err: any) {
      this.wsSend({ type: 'UNINSTALL_ERROR', toolId: msg.toolId, error: err.message });
    }
  }

  private handleToolStatus(): void {
    if (!this.pluginManager) return;
    const statuses = this.pluginManager.getPluginStatuses();
    this.wsSend({ type: 'TOOL_STATUS_REPORT', plugins: statuses });
  }

  // ---- Secret command handlers ----

  private async handleSetSecret(msg: any): Promise<void> {
    const { pluginName, key, encryptedValue, iv, authTag, wrappedAESKey } = msg;
    if (!pluginName || !key) {
      this.wsSend({ type: 'SECRET_ERROR', pluginName, error: 'Missing pluginName or key' });
      return;
    }
    try {
      // Cloud sends RSA-encrypted value — decrypt then re-encrypt for local storage
      let plainValue: string;
      if (wrappedAESKey) {
        // AES key wrapped with node's RSA public key (standard vault envelope)
        plainValue = await decryptVaultSecret(encryptedValue, iv, authTag, wrappedAESKey);
      } else {
        // C3-L1 fix: Removed plaintext msg.value fallback — all secrets must use RSA envelope
        this.wsSend({ type: 'SECRET_ERROR', pluginName, error: 'No encrypted value provided' });
        return;
      }
      await setPluginSecret(pluginName, key, plainValue);
      this.wsSend({ type: 'SECRET_ACK', pluginName, key });
    } catch (err: any) {
      // NEVER leak secret data in error messages
      this.wsSend({ type: 'SECRET_ERROR', pluginName, error: 'Failed to store secret' });
    }
  }

  private async handleDeleteSecret(msg: any): Promise<void> {
    const { pluginName, key } = msg;
    if (!pluginName || !key) {
      this.wsSend({ type: 'SECRET_ERROR', pluginName, error: 'Missing pluginName or key' });
      return;
    }
    try {
      await deletePluginSecret(pluginName, key);
      this.wsSend({ type: 'SECRET_ACK', pluginName, key, action: 'deleted' });
    } catch {
      this.wsSend({ type: 'SECRET_ERROR', pluginName, error: 'Failed to delete secret' });
    }
  }

  private async handleListSecrets(msg: any): Promise<void> {
    const { pluginName } = msg;
    if (!pluginName) {
      this.wsSend({ type: 'SECRET_ERROR', error: 'Missing pluginName' });
      return;
    }
    try {
      const keys = await listPluginSecrets(pluginName);
      this.wsSend({ type: 'SECRET_LIST', pluginName, keys });
    } catch {
      this.wsSend({ type: 'SECRET_ERROR', pluginName, error: 'Failed to list secrets' });
    }
  }

  private async handleWsTask(task: Task): Promise<void> {
    if (!this.executor || !task) return;

    if ((task as any).status === 'awaiting_approval' || (task as any).approval_id) {
      const approvalId = (task as any).approval_id;
      console.log(`🔐 Task awaiting approval: [${task.type}] ${task.payload?.command || ''}`);
      if (approvalId) {
        this.waitForApproval(task, approvalId);
      }
      return;
    }

    console.log(`🔧 Task: [${task.type}] ${task.payload?.command || task.payload?.path || ''}`);
    this.lastTaskAt = new Date().toISOString();
    this.lastSuccessfulPoll = Date.now(); // Watchdog: WS task received = alive
    updateHealthState({ lastTaskAt: this.lastTaskAt });
    // Mark task as started in DB
    this.markTaskStarted(task.id).catch(() => {});
    try {
      const result = await this.executor.execute(task);
      this.wsSend({ type: 'result', taskId: task.id, result });
      await this.reportResult(task.id, result).catch(() => {});
    } catch (err: any) {
      console.error(`❌ Task ${task.id} failed:`, err.message);
      const failResult = { status: 'failed' as const, error: err.message };
      this.wsSend({ type: 'result', taskId: task.id, result: failResult });
      await this.reportResult(task.id, failResult).catch(() => {});
    }
  }

  private async waitForApproval(task: Task, approvalId: string): Promise<void> {
    const POLL_MS = 5000;
    const TIMEOUT_MS = 30 * 60 * 1000;
    const start = Date.now();

    const poll = async () => {
      if (!this.running) return;
      if (Date.now() - start > TIMEOUT_MS) {
        console.log(`⏰ Task ${task.id} approval expired (30min timeout)`);
        await this.reportResult(task.id, { status: 'failed', error: 'Approval timed out' }).catch(() => {});
        return;
      }

      try {
        const res = await fetch(`${BASE_URL}/api/node/tasks/${task.id}/status`, {
          headers: { 'x-node-key': this.apiKey },
        });
        if (!res.ok) {
          setTimeout(poll, POLL_MS);
          return;
        }
        const data = await res.json() as any;
        const status = data.data?.status || data.status;

        if (status === 'pending' || status === 'dispatched') {
          console.log(`✅ Task ${task.id} approved — executing`);
          try {
            const result = await this.executor!.execute(task);
            this.wsSend({ type: 'result', taskId: task.id, result });
            await this.reportResult(task.id, result).catch(() => {});
          } catch (err: any) {
            const failResult = { status: 'failed' as const, error: err.message };
            this.wsSend({ type: 'result', taskId: task.id, result: failResult });
            await this.reportResult(task.id, failResult).catch(() => {});
          }
        } else if (status === 'failed') {
          console.log(`🚫 Task ${task.id} denied by user`);
        } else if (status === 'awaiting_approval') {
          setTimeout(poll, POLL_MS);
        } else {
          console.log(`❓ Task ${task.id} status: ${status}`);
        }
      } catch {
        setTimeout(poll, POLL_MS);
      }
    };

    poll();
  }

  // ---- Ping / Pong stale detection ----

  private startPingPong(): void {
    this.stopPingPong();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      this.awaitingPong = true;
      this.ws.ping();
      this.pongTimer = setTimeout(() => {
        if (this.awaitingPong) {
          console.log('⚠️  WebSocket stale (no pong) — reconnecting');
          this.ws?.close();
        }
      }, PONG_TIMEOUT);
    }, PING_INTERVAL);
  }

  private stopPingPong(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
    this.awaitingPong = false;
  }

  // ---- Helpers ----

  private wsSend(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startWsHeartbeat(): void {
    this.stopWsHeartbeat();
    const config = loadConfig();
    this.wsHeartbeatTimer = setInterval(() => {
      this.wsSend({
        type: 'heartbeat',
        role: config.role || 'any',
        capabilities: detectCapabilities(),
      });
    }, HEARTBEAT_INTERVAL);
  }

  private stopWsHeartbeat(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const jitter = (Math.random() - 0.5) * 2 * BACKOFF_JITTER; // ±500ms
    const delay = Math.min(this.reconnectDelay + jitter, BACKOFF_CAP);
    console.log(`🔄 WebSocket reconnect in ${Math.round(delay / 1000)}s...`);

    setTimeout(() => {
      if (this.running && !this.wsConnected) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, BACKOFF_CAP);
        this.connectWebSocket();
      }
    }, Math.max(delay, 500));
  }

  // ---- Software Update ----

  private getCurrentVersion(): string {
    try {
      const pkgPath = require('path').resolve(__dirname, '..', 'package.json');
      const pkg = JSON.parse(require('fs').readFileSync(pkgPath, 'utf8'));
      return pkg.version || '0.0.0';
    } catch {
      return '0.0.0';
    }
  }

  private handleCheckVersion(): void {
    this.wsSend({
      type: 'VERSION_REPORT',
      version: this.getCurrentVersion(),
      uptime: Date.now() - this.startedAt,
      platform: require('os').platform(),
    });
  }

  // ---- Internal Watchdog ----

  private startWatchdog(): void {
    if (this.watchdogTimer) return;
    console.log('🐕 Watchdog started (stale check every 10m, max uptime 24h)');
    this.watchdogTimer = setInterval(() => this.watchdogCheck(), WATCHDOG_CHECK_INTERVAL);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private watchdogCheck(): void {
    const now = Date.now();
    const uptime = now - this.startedAt;
    const sincePoll = now - this.lastSuccessfulPoll;

    // Max uptime: force a fresh WS reconnect (don't exit — Windows schtasks won't restart us reliably)
    if (uptime >= WATCHDOG_MAX_UPTIME) {
      const hours = Math.round(uptime / 3600000 * 10) / 10;
      console.log(`🐕 Watchdog: max uptime reached (${hours}h) — forcing WS reconnect`);
      this.startedAt = Date.now(); // Reset uptime counter
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.wsConnected = false;
      this.stopWsHeartbeat();
      this.stopPingPong();
      this.scheduleReconnect();
      return;
    }

    // Stale connection: force WS reconnect
    if (sincePoll >= WATCHDOG_STALE_THRESHOLD && this.wsConnected) {
      const mins = Math.round(sincePoll / 60000);
      console.log(`🐕 Watchdog: no successful activity in ${mins}m — forcing WS reconnect`);
      if (this.ws) {
        this.ws.close();
        this.ws = null;
      }
      this.wsConnected = false;
      this.stopWsHeartbeat();
      this.stopPingPong();
      this.startPolling();
      this.scheduleReconnect();
    }

    // Log health
    const uptimeMin = Math.round(uptime / 60000);
    const stateStr = this._state;
    console.log(`🐕 Watchdog: uptime=${uptimeMin}m state=${stateStr} lastActivity=${Math.round(sincePoll / 1000)}s ago`);
  }

  async peerExecute(targetNodeName: string, task: any): Promise<any> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingPeerRequests.delete(requestId);
        reject(new Error(`Peer task timeout: ${targetNodeName}`));
      }, 60000);

      this.pendingPeerRequests.set(requestId, { resolve, reject, timeout });
      this.wsSend({
        type: 'peer_task',
        target_node: targetNodeName,
        request_id: requestId,
        task,
      });
    });
  }

  stop(): void {
    this.running = false;
    this.stopPolling();
    this.stopWsHeartbeat();
    this.stopPingPong();
    this.stopWatchdog();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    // Clean up pending peer requests
    for (const [id, pending] of this.pendingPeerRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this.pendingPeerRequests.clear();

    this.setState(ConnectionState.DISCONNECTED);
  }

  private async fetchTasks(): Promise<Task[]> {
    const res = await fetch(`${BASE_URL}/api/node/tasks`, {
      headers: { 'x-node-key': this.apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.data || data.tasks || [];
  }

  private async markTaskStarted(taskId: string): Promise<void> {
    await fetch(`${BASE_URL}/api/node/tasks/${taskId}/started`, {
      method: 'POST',
      headers: { 'x-node-key': this.apiKey },
    });
  }

  private async reportResult(taskId: string, result: any): Promise<void> {
    await fetch(`${BASE_URL}/api/node/tasks/${taskId}/result`, {
      method: 'POST',
      headers: {
        'x-node-key': this.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(result),
    });
  }
}
