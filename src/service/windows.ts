/**
 * Windows service management via node-windows
 */

import type { ServiceAction } from './install';

export async function windowsService(action: ServiceAction, nodePath: string, scriptPath: string): Promise<void> {
  let nodeWindows: any;
  try {
    nodeWindows = require('node-windows');
  } catch {
    console.error('❌ node-windows not installed. Run: npm install node-windows');
    process.exit(1);
  }

  const { Service } = nodeWindows;
  const svc = new Service({
    name: 'BuhdiNode',
    description: 'Buhdi Node — connect your computer to your AI',
    script: scriptPath,
    scriptOptions: 'daemon',
    nodeOptions: [],
    execPath: nodePath,
  });

  // Recovery options
  svc.on('install', () => {
    console.log('✅ Service installed');
    // Set recovery: restart after 5s, 30s, 60s
    const { exec } = require('child_process');
    exec('sc failure BuhdiNode reset= 86400 actions= restart/5000/restart/30000/restart/60000', (err: any) => {
      if (err) console.warn('⚠️  Could not set recovery options:', err.message);
      svc.start();
    });
  });

  svc.on('uninstall', () => console.log('✅ Service uninstalled'));
  svc.on('start', () => console.log('✅ Service started'));
  svc.on('stop', () => console.log('✅ Service stopped'));
  svc.on('error', (err: any) => console.error('❌ Service error:', err));

  switch (action) {
    case 'install':
      console.log('📦 Installing Windows service...');
      svc.install();
      break;
    case 'uninstall':
      svc.uninstall();
      break;
    case 'start':
      svc.start();
      break;
    case 'stop':
      svc.stop();
      break;
    case 'restart':
      svc.restart();
      break;
    case 'status':
      // node-windows doesn't have a status check, use sc query
      const { execSync } = require('child_process');
      try {
        const out = execSync('sc query BuhdiNode', { encoding: 'utf8' });
        console.log(out);
      } catch {
        console.log('Service not installed or not found');
      }
      break;
  }
}
