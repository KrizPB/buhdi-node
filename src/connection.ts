import { TaskExecutor, Task } from './executor';
import WebSocket from 'ws';
import { ensureKeypair, getPublicKey, syncVaultForNewNodes } from './vault';

const BASE_URL = 'https://www.mybuhdi.com';
const WS_URL = 'wss://buhdi-ws.fly.dev/ws';
const POLL_INTERVAL = 5000;
const HEARTBEAT_INTERVAL = 30000;
const MAX_RECONNECT_DELAY = 60000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class NodeConnection {
  private apiKey: string;
  private nodeId: string | null = null;
  private nodeName: string = 'Unknown';
  private running = false;
  private ws: WebSocket | null = null;
  private wsConnected = false;
  private reconnectDelay = 1000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private executor: TaskExecutor | null = null;
  private polling = false;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  get name(): string {
    return this.nodeName;
  }

  async connect(systemInfo: any, software: string[]): Promise<void> {
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

      // Check for pending vault sync (re-encrypt secrets for new nodes)
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
          body: JSON.stringify({ node_id: this.nodeId }),
        });
      } catch { /* silent */ }
    }, HEARTBEAT_INTERVAL);
  }

  /** Start listening — WebSocket primary, polling fallback on disconnect */
  async startListening(executor: TaskExecutor): Promise<void> {
    this.executor = executor;
    executor.setApiKey(this.apiKey);
    this.running = true;

    // Always try WebSocket first
    this.connectWebSocket();

    // Block until stopped
    while (this.running) {
      await sleep(1000);
    }
  }

  /** Start polling as fallback when WS is down */
  private startPolling(): void {
    if (this.polling || !this.running) return;
    this.polling = true;
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
      for (const task of tasks) {
        console.log(`🔧 Task: [${task.type}] ${task.payload?.command || task.payload?.path || ''}`);
        const result = await this.executor.execute(task);
        await this.reportResult(task.id, result);
      }
    } catch (err: any) {
      if (!err?.message?.includes('fetch')) {
        console.error('⚠️  Poll error:', err?.message || err);
      }
    }

    // Schedule next poll
    if (this.polling && this.running) {
      this.pollTimer = setTimeout(() => this.pollLoop(), POLL_INTERVAL);
    }
  }

  private connectWebSocket(): void {
    console.log('🔌 Connecting via WebSocket...');

    try {
      this.ws = new WebSocket(WS_URL);
    } catch (err: any) {
      console.error('❌ WebSocket creation failed:', err.message);
      this.startPolling();
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      // MEDIUM-6: API key sent over WSS (TLS-encrypted). Acceptable for now.
      // TODO v2: Consider challenge-response auth to avoid sending key at all.
      this.wsSend({ type: 'auth', key: this.apiKey });
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
      this.stopWsHeartbeat();

      if (wasConnected) {
        console.log(`🔌 WebSocket disconnected (${code})`);
      }

      if (this.running) {
        // Start polling immediately as fallback
        this.startPolling();
        // Try to reconnect WS in background
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('⚠️  WebSocket error:', err.message);
    });
  }

  private handleWsMessage(msg: any): void {
    switch (msg.type) {
      case 'welcome':
        this.wsConnected = true;
        this.reconnectDelay = 1000;
        this.nodeName = msg.nodeName || this.nodeName;
        this.nodeId = msg.nodeId || this.nodeId;
        console.log(`✅ WebSocket connected as "${this.nodeName}"`);
        this.startWsHeartbeat();
        // Stop polling — WS is handling tasks now
        if (this.polling) {
          console.log('📡 WebSocket restored — polling disabled');
          this.stopPolling();
        }
        break;

      case 'ping':
        this.wsSend({ type: 'pong' });
        break;

      case 'task':
        this.handleWsTask(msg.task);
        break;

      default:
        break;
    }
  }

  private async handleWsTask(task: Task): Promise<void> {
    if (!this.executor || !task) return;

    // Handle tasks awaiting approval
    if ((task as any).status === 'awaiting_approval' || (task as any).approval_id) {
      const approvalId = (task as any).approval_id;
      console.log(`🔐 Task awaiting approval: [${task.type}] ${task.payload?.command || ''}`);
      if (approvalId) {
        this.waitForApproval(task, approvalId);
      }
      return;
    }

    console.log(`🔧 Task: [${task.type}] ${task.payload?.command || task.payload?.path || ''}`);
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
    const TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
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
          // Approved! Execute the task
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
          // Unknown status, stop polling
          console.log(`❓ Task ${task.id} status: ${status}`);
        }
      } catch {
        setTimeout(poll, POLL_MS);
      }
    };

    poll();
  }

  private wsSend(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startWsHeartbeat(): void {
    this.stopWsHeartbeat();
    this.wsHeartbeatTimer = setInterval(() => {
      this.wsSend({ type: 'heartbeat' });
    }, HEARTBEAT_INTERVAL);
  }

  private stopWsHeartbeat(): void {
    if (this.wsHeartbeatTimer) {
      clearInterval(this.wsHeartbeatTimer);
      this.wsHeartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    const jitter = Math.random() * 1000;
    const delay = Math.min(this.reconnectDelay + jitter, MAX_RECONNECT_DELAY);
    console.log(`🔄 WebSocket reconnect in ${Math.round(delay / 1000)}s...`);

    setTimeout(() => {
      if (this.running && !this.wsConnected) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
        this.connectWebSocket();
      }
    }, delay);
  }

  stop(): void {
    this.running = false;
    this.stopPolling();
    this.stopWsHeartbeat();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private async fetchTasks(): Promise<Task[]> {
    const res = await fetch(`${BASE_URL}/api/node/tasks`, {
      headers: { 'x-node-key': this.apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.data || data.tasks || [];
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
