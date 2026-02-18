import { exec } from 'child_process';
import fs from 'fs/promises';
import { detectSystem, detectSoftware } from './handshake';

export interface Task {
  id: string;
  type: string;
  payload: any;
}

export interface TaskResult {
  status: 'completed' | 'failed';
  result?: any;
  error?: string;
}

export class TaskExecutor {
  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();
    try {
      let result: any;
      switch (task.type) {
        case 'shell':
          result = await this.execShell(task.payload.command, task.payload.cwd);
          break;
        case 'file_read':
          result = await fs.readFile(task.payload.path, 'utf8');
          break;
        case 'file_write':
          await fs.writeFile(task.payload.path, task.payload.content);
          result = { written: task.payload.path };
          break;
        case 'system_info':
          result = { system: detectSystem(), software: detectSoftware() };
          break;
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`✅ Completed in ${elapsed}s`);
      return { status: 'completed', result };
    } catch (err: any) {
      console.log(`❌ Failed: ${err.message}`);
      return { status: 'failed', error: err.message };
    }
  }

  private execShell(command: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }
}
