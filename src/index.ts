#!/usr/bin/env node

import { loadConfig, saveConfig } from './config';
import { detectSystem, detectSoftware } from './handshake';
import { NodeConnection } from './connection';
import { TaskExecutor } from './executor';

const VERSION = '0.1.0';

function printUsage(): void {
  console.log(`
🐻 Buhdi Node v${VERSION}

Usage:
  buhdi-node connect <API_KEY>    Connect to mybuhdi.com
  buhdi-node --key <API_KEY>      Same as above
  buhdi-node status               Show system info
  buhdi-node --help               Show this help

Environment:
  BUHDI_NODE_KEY                  API key (alternative to CLI arg)
`);
}

function printSystemInfo(info: ReturnType<typeof detectSystem>): void {
  console.log(`📊 System: ${info.os} ${info.arch} | ${info.ram_gb}GB RAM | ${info.disk_free_gb}GB free`);
  console.log(`   CPU: ${info.cpu}`);
  console.log(`   Host: ${info.hostname}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  if (args[0] === 'status') {
    console.log(`🐻 Buhdi Node v${VERSION}\n`);
    const info = detectSystem();
    printSystemInfo(info);
    console.log('\n🔧 Software:');
    for (const s of detectSoftware()) {
      console.log(`   ${s}`);
    }
    process.exit(0);
  }

  // Resolve API key
  let apiKey: string | undefined;
  if (args[0] === 'connect' && args[1]) {
    apiKey = args[1];
  } else if (args[0] === '--key' && args[1]) {
    apiKey = args[1];
  }
  apiKey = apiKey || process.env.BUHDI_NODE_KEY;

  if (!apiKey) {
    const config = loadConfig();
    apiKey = config.apiKey;
  }

  if (!apiKey) {
    console.error('❌ No API key provided. Use: buhdi-node connect <API_KEY>');
    process.exit(1);
  }

  // Save key to config
  const config = loadConfig();
  config.apiKey = apiKey;
  saveConfig(config);

  console.log(`🐻 Buhdi Node v${VERSION}`);
  console.log('🔑 Authenticating...\n');

  const systemInfo = detectSystem();
  const software = detectSoftware();
  printSystemInfo(systemInfo);
  console.log('');

  const connection = new NodeConnection(apiKey);

  try {
    await connection.connect(systemInfo, software);
    console.log(`✅ Connected as "${connection.name}"\n`);
  } catch (err: any) {
    console.error(`❌ Connection failed: ${err.message}`);
    console.error('   Server APIs may not be deployed yet. Entering offline poll mode.\n');
  }

  connection.startHeartbeat();

  const executor = new TaskExecutor();

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n👋 Disconnecting...');
    connection.stop();
    process.exit(0);
  });

  await connection.startPolling(executor);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
