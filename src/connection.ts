import { TaskExecutor, Task } from './executor';

const BASE_URL = 'https://www.mybuhdi.com';
const POLL_INTERVAL = 3000;
const HEARTBEAT_INTERVAL = 30000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class NodeConnection {
  private apiKey: string;
  private nodeId: string | null = null;
  private nodeName: string = 'Unknown';
  private running = false;

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
      body: JSON.stringify({ system: systemInfo, software }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Connection failed (${res.status}): ${text}`);
    }

    const data = await res.json() as any;
    this.nodeId = data.node_id;
    this.nodeName = data.node_name || 'Unknown';
  }

  startHeartbeat(): void {
    setInterval(async () => {
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
      } catch {
        // Connection error — retry silently
      }
      await sleep(POLL_INTERVAL);
    }
  }

  stop(): void {
    this.running = false;
  }

  private async fetchTasks(): Promise<Task[]> {
    const res = await fetch(`${BASE_URL}/api/node/tasks`, {
      headers: { 'x-node-key': this.apiKey },
    });
    if (!res.ok) return [];
    const data = await res.json() as any;
    return data.tasks || [];
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
