/**
 * Service installer — platform detection + router
 */

import os from 'os';
import path from 'path';

export type ServiceAction = 'install' | 'uninstall' | 'start' | 'stop' | 'restart' | 'status';

function getNodePath(): string {
  return process.execPath;
}

function getScriptPath(): string {
  return path.resolve(__dirname, '..', 'index.js');
}

export async function serviceAction(action: ServiceAction): Promise<void> {
  const platform = os.platform();
  const nodePath = getNodePath();
  const scriptPath = getScriptPath();

  switch (platform) {
    case 'win32': {
      const { windowsService } = await import('./windows');
      await windowsService(action, nodePath, scriptPath);
      break;
    }
    case 'darwin': {
      const { macosService } = await import('./macos');
      await macosService(action, nodePath, scriptPath);
      break;
    }
    case 'linux': {
      const { linuxService } = await import('./linux');
      await linuxService(action, nodePath, scriptPath);
      break;
    }
    default:
      console.error(`❌ Unsupported platform: ${platform}`);
      process.exit(1);
  }
}
