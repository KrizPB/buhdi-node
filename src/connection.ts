import { TaskExecutor, Task } from './executor';
import WebSocket from 'ws';

const BASE_URL = 'https://www.mybuhdi.com';
const WS_URL = 'wss://buhdi-ws.fly.dev/ws';
const POLL_INTERVAL = 3000;
const HEARTBEAT_INTERVAL = 30000;
const MAX_WS_FAILURES = 3;
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
  private wsFailures = 0;
  private reconnectDelay = 1000;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wsHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private executor: TaskExecutor | null = null;

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

  /** Start listening for tasks — tries WebSocket first, falls back to polling */
  async startListening(executor: TaskExecutor): Promise<void> {
    this.executor = executor;
    this.running = true;

    if (this.wsFailures < MAX_WS_FAILURES) {
      this.connectWebSocket();
      // Wait a bit to see if WS connects, then fall through to polling if not
      await sleep(5000);
      if (this.wsConnected) {
        console.log('📡 Receiving tasks via WebSocket (HTTP polling disabled)');
        // Keep running — tasks come via WS callbacks
        // Just block until stopped
        while (this.running) {
          await sleep(1000);
        }
        return;
      }
    }

    // Fallback to polling
    console.log('🔄 Falling back to HTTP polling...');
    await this.startPolling(executor);
  }

  /** Legacy HTTP polling — kept as fallback */
  async startPolling(executor: TaskExecutor): Promise<void> {
    this.running = true;
    console.log('🔄 Polling for tasks...');

    while (this.running) {
      try {
        const tasks = await this.fetchTasks();
        for (const task of tasks) {
          console.log(`🔧 Task: [${task.type}] ${task.payload?.command || task.payload?.path || ''}`);
          const result = await executor.execute(task);
          await this.reportResult(task.id, result);
        }
      } catch (err: any) {
        if (err?.message?.includes('fetch')) {
          // Network error — silent retry
        } else {
          console.error('⚠️  Poll error:', err?.message || err);
        }
      }
      await sleep(POLL_INTERVAL);
    }
  }

  private connectWebSocket(): void {
    const url = `${WS_URL}?key=${this.apiKey}`;
    console.log('🔌 Connecting via WebSocket...');

    try {
      this.ws = new WebSocket(url);
    } catch (err: any) {
      console.error('❌ WebSocket creation failed:', err.message);
      this.handleWsFailure();
      return;
    }

    this.ws.on('open', () => {
      // Wait for welcome message to confirm connection
    });

    this.ws.on('message', (raw: WebSocket.Data) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleWsMessage(msg);
      } catch {
        console.error('⚠️  Invalid WS message:', raw.toString().slice(0, 100));
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      const wasConnected = this.wsConnected;
      this.wsConnected = false;
      this.stopWsHeartbeat();

      if (wasConnected) {
        console.log(`🔌 WebSocket disconnected (${code})`);
      }

      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      // Error is followed by close, so just log
      console.error('⚠️  WebSocket error:', err.message);
    });
  }

  private handleWsMessage(msg: any): void {
    switch (msg.type) {
      case 'welcome':
        this.wsConnected = true;
        this.wsFailures = 0;
        this.reconnectDelay = 1000;
        this.nodeName = msg.nodeName || this.nodeName;
        this.nodeId = msg.nodeId || this.nodeId;
        console.log(`✅ WebSocket connected as "${this.nodeName}"`);
        this.startWsHeartbeat();
        break;

      case 'ping':
        this.wsSend({ type: 'pong' });
        break;

      case 'task':
        this.handleWsTask(msg.task);
        break;

      default:
        // Ignore unknown messages
        break;
    }
  }

  private async handleWsTask(task: Task): Promise<void> {
    if (!this.executor || !task) return;
    console.log(`🔧 Task: [${task.type}] ${task.payload?.command || task.payload?.path || ''}`);
    try {
      const result = await this.executor.execute(task);
      this.wsSend({ type: 'result', taskId: task.id, result });
    } catch (err: any) {
      console.error(`❌ Task ${task.id} failed:`, err.message);
      this.wsSend({ type: 'result', taskId: task.id, result: { status: 'error', error: err.message } });
    }
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

  private handleWsFailure(): void {
    this.wsFailures++;
    if (this.wsFailures >= MAX_WS_FAILURES) {
      console.log(`⚠️  WebSocket failed ${this.wsFailures} times, falling back to HTTP polling`);
    }
  }

  private scheduleReconnect(): void {
    this.handleWsFailure();
    if (this.wsFailures >= MAX_WS_FAILURES) return; // Let startListening fall through to polling

    const jitter = Math.random() * 1000;
    const delay = Math.min(this.reconnectDelay + jitter, MAX_RECONNECT_DELAY);
    console.log(`🔄 Reconnecting in ${Math.round(delay / 1000)}s...`);

    setTimeout(() => {
      if (this.running) {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
        this.connectWebSocket();
      }
    }, delay);
  }

  stop(): void {
    this.running = false;
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
