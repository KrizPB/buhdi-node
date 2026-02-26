import { execSync } from 'child_process';

function commandExists(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

let cachedCapabilities: string[] | null = null;

export function detectCapabilities(): string[] {
  if (cachedCapabilities) return cachedCapabilities;

  const caps: string[] = ['node', 'shell'];

  const checks: [string, string][] = [
    ['python', 'python --version'],
    ['python', 'python3 --version'],
    ['git', 'git --version'],
    ['docker', 'docker --version'],
    ['ffmpeg', 'ffmpeg -version'],
    ['gpu', 'nvidia-smi --query-gpu=name --format=csv,noheader'],
  ];

  for (const [name, cmd] of checks) {
    if (!caps.includes(name) && commandExists(cmd)) {
      caps.push(name);
    }
  }

  cachedCapabilities = caps;
  return caps;
}
