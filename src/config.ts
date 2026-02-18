import fs from 'fs';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.buhdi-node');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface BuhdiConfig {
  apiKey?: string;
  nodeId?: string;
}

export function loadConfig(): BuhdiConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveConfig(config: BuhdiConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}
