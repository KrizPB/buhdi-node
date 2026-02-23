/**
 * Linux systemd user service management
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import type { ServiceAction } from './install';

const SERVICE_NAME = 'buhdi-node';
const UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const UNIT_PATH = path.join(UNIT_DIR, `${SERVICE_NAME}.service`);

function generateUnit(nodePath: string, scriptPath: string): string {
  return `[Unit]
Description=Buhdi Node — connect your computer to your AI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${nodePath} ${scriptPath} daemon
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=default.target
`;
}

export async function linuxService(action: ServiceAction, nodePath: string, scriptPath: string): Promise<void> {
  switch (action) {
    case 'install': {
      fs.mkdirSync(UNIT_DIR, { recursive: true });
      fs.writeFileSync(UNIT_PATH, generateUnit(nodePath, scriptPath));
      execSync('systemctl --user daemon-reload');
      execSync(`systemctl --user enable ${SERVICE_NAME}`);
      console.log(`✅ Service installed at ${UNIT_PATH}`);
      break;
    }
    case 'uninstall':
      try { execSync(`systemctl --user stop ${SERVICE_NAME}`); } catch {}
      try { execSync(`systemctl --user disable ${SERVICE_NAME}`); } catch {}
      try { fs.unlinkSync(UNIT_PATH); } catch {}
      execSync('systemctl --user daemon-reload');
      console.log('✅ Service uninstalled');
      break;
    case 'start':
      execSync(`systemctl --user start ${SERVICE_NAME}`);
      console.log('✅ Service started');
      break;
    case 'stop':
      execSync(`systemctl --user stop ${SERVICE_NAME}`);
      console.log('✅ Service stopped');
      break;
    case 'restart':
      execSync(`systemctl --user restart ${SERVICE_NAME}`);
      console.log('✅ Service restarted');
      break;
    case 'status':
      try {
        const out = execSync(`systemctl --user status ${SERVICE_NAME}`, { encoding: 'utf8' });
        console.log(out);
      } catch (err: any) {
        console.log(err.stdout || 'Service not found');
      }
      break;
  }
}
