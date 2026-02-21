/**
 * macOS launchd service management
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import type { ServiceAction } from './install';

const PLIST_NAME = 'com.mybuhdi.node';
const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${PLIST_NAME}.plist`);
const LOG_DIR = path.join(os.homedir(), '.buhdi-node', 'logs');

function generatePlist(nodePath: string, scriptPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${scriptPath}</string>
        <string>daemon</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>`;
}

export async function macosService(action: ServiceAction, nodePath: string, scriptPath: string): Promise<void> {
  switch (action) {
    case 'install': {
      fs.mkdirSync(path.dirname(PLIST_PATH), { recursive: true });
      fs.mkdirSync(LOG_DIR, { recursive: true });
      fs.writeFileSync(PLIST_PATH, generatePlist(nodePath, scriptPath));
      console.log(`✅ Plist written to ${PLIST_PATH}`);
      execSync(`launchctl load ${PLIST_PATH}`);
      console.log('✅ Service loaded');
      break;
    }
    case 'uninstall':
      try { execSync(`launchctl unload ${PLIST_PATH}`); } catch {}
      try { fs.unlinkSync(PLIST_PATH); } catch {}
      console.log('✅ Service uninstalled');
      break;
    case 'start':
      execSync(`launchctl start ${PLIST_NAME}`);
      console.log('✅ Service started');
      break;
    case 'stop':
      execSync(`launchctl stop ${PLIST_NAME}`);
      console.log('✅ Service stopped');
      break;
    case 'restart':
      try { execSync(`launchctl stop ${PLIST_NAME}`); } catch {}
      execSync(`launchctl start ${PLIST_NAME}`);
      console.log('✅ Service restarted');
      break;
    case 'status':
      try {
        const out = execSync(`launchctl list ${PLIST_NAME}`, { encoding: 'utf8' });
        console.log(out);
      } catch {
        console.log('Service not loaded');
      }
      break;
  }
}
