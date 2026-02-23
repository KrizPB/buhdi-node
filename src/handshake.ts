import os from 'os';
import { execSync } from 'child_process';

function getDiskFree(): number {
  try {
    if (os.platform() === 'win32') {
      const out = execSync('wmic logicaldisk get freespace', { encoding: 'utf8', timeout: 5000 });
      const lines = out.trim().split('\n').slice(1);
      let total = 0;
      for (const line of lines) {
        const val = parseInt(line.trim(), 10);
        if (!isNaN(val)) total += val;
      }
      return Math.round(total / 1073741824);
    } else {
      const out = execSync('df -k / | tail -1', { encoding: 'utf8', timeout: 5000 });
      const parts = out.trim().split(/\s+/);
      const avail = parseInt(parts[3], 10);
      return Math.round(avail / 1048576);
    }
  } catch {
    return 0;
  }
}

export function detectSystem() {
  return {
    os: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    ram_gb: Math.round(os.totalmem() / 1073741824),
    disk_free_gb: getDiskFree(),
    cpu: os.cpus()[0]?.model || 'Unknown',
    hostname: os.hostname(),
    platform: os.platform(),
    homedir: os.homedir(),
    workspace: process.env.BUHDI_WORKSPACE || os.homedir(),
  };
}

export function detectSoftware(): string[] {
  const found: string[] = [];
  const checks = [
    { name: 'node', cmd: 'node --version' },
    { name: 'npm', cmd: 'npm --version' },
    { name: 'python', cmd: 'python --version' },
    { name: 'git', cmd: 'git --version' },
    { name: 'docker', cmd: 'docker --version' },
  ];
  for (const c of checks) {
    try {
      const v = execSync(c.cmd, { timeout: 5000, encoding: 'utf8' }).trim();
      found.push(`${c.name} ${v}`);
    } catch { /* not installed */ }
  }
  return found;
}
