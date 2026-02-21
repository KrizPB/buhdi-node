/**
 * Run Logger — logs plugin execution results to cloud, buffers when offline.
 */

const MAX_BUFFER = 100;

interface RunRecord {
  toolName: string;
  version: string;
  status: 'success' | 'error' | 'timeout';
  started_at: string;
  completed_at: string;
  duration_ms: number;
  error?: string;
  error_count?: number;
  input_summary?: string;
  output_summary?: string;
}

export class RunLogger {
  private buffer: RunRecord[] = [];
  private apiKey: string;
  private nodeId: string;
  private baseUrl: string;
  private flushing = false;

  constructor(opts: { apiKey: string; nodeId: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.nodeId = opts.nodeId;
    this.baseUrl = opts.baseUrl ?? 'https://www.mybuhdi.com';
  }

  async logRun(record: RunRecord): Promise<void> {
    this.buffer.push(record);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer.shift(); // drop oldest
    }
    await this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;

    const toSend = [...this.buffer];
    const sent: number[] = [];

    for (let i = 0; i < toSend.length; i++) {
      const record = toSend[i];
      try {
        const res = await fetch(
          `${this.baseUrl}/api/node/tools/${encodeURIComponent(record.toolName)}/runs`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-node-key': this.apiKey,
            },
            body: JSON.stringify(record),
          }
        );
        if (res.ok) {
          sent.push(i);
        }
      } catch {
        // Offline — stop trying, will retry later
        break;
      }
    }

    // Remove sent items (reverse order to preserve indices)
    for (const idx of sent.reverse()) {
      this.buffer.splice(idx, 1);
    }

    this.flushing = false;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }
}
