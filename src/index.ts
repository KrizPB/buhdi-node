#!/usr/bin/env node

import { loadConfig, saveConfig, getApiKey, setApiKey } from './config';
import { detectSystem, detectSoftware } from './handshake';
import { NodeConnection, ConnectionState } from './connection';
import { TaskExecutor } from './executor';
import { scanTools } from './tools';
import { initLogger, getLogger } from './logger';
import { startHealthServer, updateHealthState } from './health';
import { startDashboardServer, getDashboardToken } from './dashboard';
import { setupDaemon } from './daemon';
import { serviceAction } from './service/install';
import { PluginManager } from './plugins/manager';
import { TrustLevel, isValidTrustLevel, trustLevelLabel, TRUST_LEVELS } from './plugins/trust';
import { listPluginSecrets } from './plugins/plugin-vault';
import fs from 'fs';
import path from 'path';
import os from 'os';

const VERSION = '0.3.0';

function printUsage(): void {
  console.log(`
🐻 Buhdi Node v${VERSION}

Usage:
  buhdi-node connect <API_KEY>    Connect to mybuhdi.com
  buhdi-node reconnect <TOKEN>    Reconnect using a dashboard token
  buhdi-node setup <API_KEY>      Save & validate API key
  buhdi-node daemon               Run in daemon mode (no TTY)
  buhdi-node status               Show system & connection info
  buhdi-node logs                 Tail recent log files
  buhdi-node --key <API_KEY>      Same as connect
  buhdi-node memory [API_KEY]      Connect/check cloud memory
  buhdi-node trust [level]         View/set trust level
  buhdi-node pending               List plugins awaiting approval
  buhdi-node plugins              List installed plugins
  buhdi-node plugin <name>        Show plugin details
  buhdi-node secrets <plugin>     List secret names for a plugin

Service management:
  buhdi-node install              Install as system service
  buhdi-node uninstall            Remove system service
  buhdi-node start                Start service
  buhdi-node stop                 Stop service
  buhdi-node restart              Restart service

Environment:
  BUHDI_NODE_KEY                  API key (alternative to CLI arg)
`);
}

function printSystemInfo(info: ReturnType<typeof detectSystem>): void {
  console.log(`📊 System: ${info.os} ${info.arch} | ${info.ram_gb}GB RAM | ${info.disk_free_gb}GB free`);
  console.log(`   CPU: ${info.cpu}`);
  console.log(`   Host: ${info.hostname}`);
}

async function runSetup(apiKey: string): Promise<void> {
  console.log(`🐻 Buhdi Node v${VERSION}`);
  console.log('🔑 Validating API key...\n');

  try {
    const res = await fetch('https://www.mybuhdi.com/api/node/connect', {
      method: 'POST',
      headers: { 'x-node-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ system_info: detectSystem(), capabilities: [] }),
    });
    if (!res.ok) {
      console.error(`❌ API key invalid (${res.status})`);
      process.exit(1);
    }
    const data = await res.json() as any;
    console.log(`✅ Key valid! Node: "${data.data?.node_name || data.node_name || 'Unknown'}"`);
  } catch (err: any) {
    console.error(`❌ Validation failed: ${err.message}`);
    process.exit(1);
  }

  setApiKey(apiKey);
  console.log('💾 API key encrypted and saved');
}

async function runConnect(apiKey: string, isDaemon = false): Promise<void> {
  if (isDaemon) {
    const config = loadConfig();
    setupDaemon(config.logLevel);
  } else {
    initLogger({ logLevel: loadConfig().logLevel || 'info' });
  }

  const config = loadConfig();
  const healthPort = config.healthPort ?? 9847;

  if (!isDaemon) {
    console.log(`🐻 Buhdi Node v${VERSION}`);
    console.log('🔑 Authenticating...\n');
  }

  const systemInfo = detectSystem();
  const software = detectSoftware();
  if (!isDaemon) {
    printSystemInfo(systemInfo);
    console.log('');
  }

  const connection = new NodeConnection(apiKey);

  // Initialize plugin manager
  const pluginManager = new PluginManager({ apiKey });
  await pluginManager.init();
  connection.setPluginManager(pluginManager);

  // Update health with plugin info
  const pluginStatuses = pluginManager.getPluginStatuses();
  updateHealthState({ pluginCount: pluginStatuses.length, pluginStatuses });

  // Log state changes
  connection.on('stateChange', (newState: ConnectionState, oldState: ConnectionState) => {
    getLogger().info(`Connection: ${oldState} → ${newState}`);
  });

  try {
    await connection.connect(systemInfo, software);
    const msg = `✅ Connected as "${connection.name}"`;
    if (isDaemon) getLogger().info(msg); else console.log(msg + '\n');
    scanTools(apiKey).catch(() => {});

    // Initialize persona system
    import('./persona').then(({ initPersona }) => {
      initPersona();
    }).catch((err: any) => {
      if (isDaemon) getLogger().warn('Persona init error: ' + err.message);
      else console.warn('⚠️  Persona init:', err.message);
    });

    // Initialize LLM router
    import('./llm').then(({ initLLMRouter }) => {
      initLLMRouter();
    }).catch((err: any) => {
      if (isDaemon) getLogger().warn('LLM router init error: ' + err.message);
      else console.warn('⚠️  LLM router init:', err.message);
    });

    // Initialize tool plugins
    import('./tool-plugins').then(({ initToolPlugins }) => {
      initToolPlugins().catch((err: any) => {
        if (isDaemon) getLogger().warn('Tool plugin init error: ' + err.message);
        else console.warn('⚠️  Tool plugin init:', err.message);
      });
    });

    // Initialize chat persistence
    import('./chats').then(({ initChats }) => {
      const configDir = process.env.BUHDI_NODE_CONFIG_DIR || path.join(os.homedir(), '.buhdi-node');
      initChats(configDir);
    }).catch(() => {});

    // Initialize scheduler
    import('./scheduler').then(async ({ initScheduler }) => {
      const { addActivity } = await import('./health');
      const configDir = process.env.BUHDI_NODE_CONFIG_DIR || path.join(os.homedir(), '.buhdi-node');
      initScheduler(configDir, addActivity, {
        allowScripts: (config as any).scheduler?.allowScripts === true,
      });
    }).catch((err: any) => {
      if (isDaemon) getLogger().warn('Scheduler init error: ' + err.message);
      else console.warn('⚠️  Scheduler init:', err.message);
    });

    // Initialize local memory
    import('./memory').then(({ initMemory }) => {
      const memConfig: any = {};
      if ((config as any).memory) {
        Object.assign(memConfig, (config as any).memory);
      }
      // Use Ollama URL from LLM config if available
      if ((config as any).llm?.providers) {
        const ollama = (config as any).llm.providers.find((p: any) => p.type === 'ollama');
        if (ollama?.url) memConfig.ollama_url = ollama.url;
      }
      initMemory(memConfig).catch((err: any) => {
        if (isDaemon) getLogger().warn('Memory init error: ' + err.message);
        else console.warn('⚠️  Memory init:', err.message);
      });
    });
  } catch (err: any) {
    const msg = `Connection failed: ${err.message}`;
    if (isDaemon) getLogger().error(msg); else console.error(`❌ ${msg}\n   Entering offline poll mode.\n`);
  }

  // Start health server
  const healthServer = startHealthServer(healthPort);
  if (healthServer && !isDaemon) {
    console.log(`🏥 Health: http://localhost:${healthPort}/health`);
  }

  // Start dashboard server
  const dashboardPort = config.dashboardPort ?? 3847;
  const dashboardServer = startDashboardServer(dashboardPort);
  if (dashboardServer && !isDaemon) {
    const dashToken = getDashboardToken();
    console.log(`📊 Dashboard: http://localhost:${dashboardPort}/`);
    if (dashToken) {
      console.log(`🔑 Dashboard token: ${dashToken}`);
    }
  }

  connection.startHeartbeat();
  const executor = new TaskExecutor();

  process.on('SIGINT', async () => {
    if (!isDaemon) console.log('\n👋 Disconnecting...');
    await pluginManager.stopAll();
    connection.stop();
    healthServer?.close();
    dashboardServer?.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    getLogger().info('SIGTERM received, shutting down');
    await pluginManager.stopAll();
    connection.stop();
    healthServer?.close();
    dashboardServer?.close();
    process.exit(0);
  });

  await connection.startListening(executor);
}

function showStatus(): void {
  console.log(`🐻 Buhdi Node v${VERSION}\n`);

  const config = loadConfig();
  const hasKey = !!(config.apiKey_encrypted && config.apiKey_salt);
  console.log(`🔑 API Key: ${hasKey ? 'configured (encrypted)' : 'not set'}`);
  console.log(`🏥 Health port: ${config.healthPort ?? 9847}`);
  console.log(`📝 Log level: ${config.logLevel || 'info'}`);
  console.log('');

  const info = detectSystem();
  printSystemInfo(info);
  console.log('\n🔧 Software:');
  for (const s of detectSoftware()) {
    console.log(`   ${s}`);
  }

  // Check if health endpoint is responsive
  if (config.healthPort) {
    try {
      const http = require('http');
      const req = http.get(`http://127.0.0.1:${config.healthPort}/health`, (res: any) => {
        let body = '';
        res.on('data', (c: string) => body += c);
        res.on('end', () => {
          try {
            const h = JSON.parse(body);
            console.log(`\n📡 Running: ${h.status} | uptime ${h.uptime}s | ${h.connectionState}`);
          } catch {}
        });
      });
      req.on('error', () => {
        console.log('\n📡 Node process: not running');
      });
      req.end();
      // Give time for async response
      setTimeout(() => process.exit(0), 1000);
      return;
    } catch {}
  }
  process.exit(0);
}

function showLogs(): void {
  const logDir = path.join(os.homedir(), '.buhdi-node', 'logs');
  if (!fs.existsSync(logDir)) {
    console.log('No logs found');
    process.exit(0);
  }

  const files = fs.readdirSync(logDir)
    .filter(f => f.endsWith('.log'))
    .sort()
    .reverse();

  if (files.length === 0) {
    console.log('No log files found');
    process.exit(0);
  }

  const latest = path.join(logDir, files[0]);
  console.log(`📝 ${latest}\n`);
  const content = fs.readFileSync(latest, 'utf8');
  const lines = content.split('\n').slice(-50);
  console.log(lines.join('\n'));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printUsage();
    process.exit(0);
  }

  const cmd = args[0];

  // Service commands
  if (['install', 'uninstall', 'start', 'stop', 'restart'].includes(cmd)) {
    await serviceAction(cmd as any);
    return;
  }

  if (cmd === 'setup' && args[1]) {
    await runSetup(args[1]);
    return;
  }

  if (cmd === 'status') {
    showStatus();
    return;
  }

  if (cmd === 'logs') {
    showLogs();
    process.exit(0);
  }

  if (cmd === 'trust') {
    const config = loadConfig();
    const currentLevel = (config.trustLevel as TrustLevel) || TrustLevel.APPROVE_NEW;

    if (args[1]) {
      const newLevel = args[1].toLowerCase();
      if (!isValidTrustLevel(newLevel)) {
        console.error(`❌ Invalid trust level: ${newLevel}`);
        console.log(`   Valid levels: ${TRUST_LEVELS.join(', ')}`);
        process.exit(1);
      }
      config.trustLevel = newLevel;
      saveConfig(config);
      console.log(`✅ Trust level set to: ${trustLevelLabel(newLevel as TrustLevel)}`);
    } else {
      console.log(`🔐 Current trust level: ${trustLevelLabel(currentLevel)}`);
      console.log(`\nAvailable levels:`);
      for (const level of TRUST_LEVELS) {
        const marker = level === currentLevel ? ' ← current' : '';
        console.log(`  ${trustLevelLabel(level as TrustLevel)}${marker}`);
      }
      console.log(`\nSet with: buhdi-node trust <level>`);
    }
    process.exit(0);
  }

  if (cmd === 'pending') {
    const pm = new PluginManager();
    await pm.init();
    const pending = pm.listPendingPlugins();
    if (pending.length === 0) {
      console.log('No plugins awaiting approval');
    } else {
      console.log(`⏳ ${pending.length} plugin(s) pending approval:\n`);
      for (const p of pending) {
        console.log(`  ${p.name} v${p.version}`);
      }
    }
    process.exit(0);
  }

  if (cmd === 'plugins') {
    const pm = new PluginManager();
    await pm.init();
    const plugins = pm.listPlugins();
    if (plugins.length === 0) {
      console.log('No plugins installed');
    } else {
      console.log(`📦 ${plugins.length} plugin(s):\n`);
      for (const p of plugins) {
        console.log(`  ${p.name} v${p.version} [${p.status}]${p.error ? ' ⚠️ ' + p.error : ''}`);
      }
    }
    process.exit(0);
  }

  if (cmd === 'plugin' && args[1]) {
    const pm = new PluginManager();
    await pm.init();
    const p = pm.getPlugin(args[1]);
    if (!p) {
      console.log(`Plugin "${args[1]}" not found`);
      process.exit(1);
    }
    console.log(`📦 ${p.name} v${p.version}`);
    console.log(`   Status: ${p.status}`);
    console.log(`   Runtime: ${p.manifest.runtime}`);
    console.log(`   Entry: ${p.manifest.entry}`);
    if (p.manifest.description) console.log(`   Description: ${p.manifest.description}`);
    if (p.manifest.schedule) console.log(`   Schedule: ${p.manifest.schedule}`);
    if (p.manifest.permissions.network?.length) {
      console.log(`   Network: ${p.manifest.permissions.network.join(', ')}`);
    }
    if (p.error) console.log(`   Error: ${p.error}`);
    process.exit(0);
  }

  if (cmd === 'secrets' && args[1]) {
    const pluginName = args[1];
    try {
      const keys = await listPluginSecrets(pluginName);
      if (keys.length === 0) {
        console.log(`No secrets stored for plugin "${pluginName}"`);
      } else {
        console.log(`🔐 Secrets for "${pluginName}" (${keys.length}):\n`);
        for (const k of keys) {
          console.log(`  • ${k}`);
        }
        console.log('\n(Values are encrypted and never displayed)');
      }
    } catch {
      console.error(`Failed to read secrets for "${pluginName}"`);
    }
    process.exit(0);
  }

  if (cmd === 'memory' && args[1]) {
    const memoryKey = args[1];
    console.log(`🐻 Buhdi Node v${VERSION}`);
    console.log('🧠 Connecting memory to mybuhdi.com...\n');

    // Validate the key
    try {
      const res = await fetch('https://www.mybuhdi.com/api/memory/stats', {
        headers: { 'Authorization': `Bearer ${memoryKey}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        console.error(`❌ Invalid memory API key (${res.status})`);
        process.exit(1);
      }
      const data = await res.json() as any;
      console.log(`✅ Connected! Memory stats: ${data.data?.entity_count ?? data.entity_count ?? '?'} entities`);
    } catch (err: any) {
      console.error(`❌ Connection failed: ${err.message}`);
      process.exit(1);
    }

    // Safely merge into config
    const config = loadConfig();
    if (!config.memory) (config as any).memory = {};
    (config as any).memory.sync = {
      enabled: true,
      cloud_url: 'https://www.mybuhdi.com',
      api_key: memoryKey,
      interval_seconds: 300,
    };
    saveConfig(config);
    console.log('💾 Memory API key saved to config');
    console.log('\n🔄 Cloud persona sync will now work in cloud_first mode');
    console.log('   Edit persona files: ~/.buhdi-node/persona/');
    console.log('   Restart buhdi-node to apply');
    process.exit(0);
  }

  if (cmd === 'memory' && !args[1]) {
    const config = loadConfig() as any;
    const syncConfig = config.memory?.sync;
    if (syncConfig?.api_key) {
      console.log(`🧠 Memory: connected to ${syncConfig.cloud_url || 'https://www.mybuhdi.com'}`);
      console.log(`   Sync: ${syncConfig.enabled ? 'enabled' : 'disabled'}`);
      console.log(`   Interval: ${syncConfig.interval_seconds || 300}s`);
    } else {
      console.log('🧠 Memory: not connected');
      console.log('   Connect with: buhdi-node memory <API_KEY>');
      console.log('   Get your key at: https://www.mybuhdi.com/settings');
    }
    process.exit(0);
  }

  if (cmd === 'daemon') {
    // Daemon mode — resolve key and run
    const apiKey = process.env.BUHDI_NODE_KEY || getApiKey();
    if (!apiKey) {
      console.error('❌ No API key. Run "buhdi-node setup <KEY>" first.');
      process.exit(1);
    }
    await runConnect(apiKey, true);
    return;
  }

  if (cmd === 'reconnect' && args[1]) {
    const token = args[1].toUpperCase();
    console.log(`🐻 Buhdi Node v${VERSION}`);
    console.log(`🔄 Reconnecting with token: ${token}\n`);

    const apiKey = getApiKey();
    if (!apiKey) {
      console.error('❌ No saved API key. Run "buhdi-node setup <API_KEY>" first.');
      process.exit(1);
    }

    try {
      const res = await fetch('https://www.mybuhdi.com/api/node/reconnect/validate', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const data = await res.json() as any;
      if (!res.ok || !data.data?.valid) {
        console.error(`❌ Token invalid or expired: ${data.error || 'unknown error'}`);
        process.exit(1);
      }
      console.log('✅ Token validated! Reconnecting...\n');
    } catch (err: any) {
      console.error(`❌ Failed to validate token: ${err.message}`);
      process.exit(1);
    }

    await runConnect(apiKey);
    return;
  }

  // Resolve API key from args, env, or config
  let apiKey: string | undefined;
  if (cmd === 'connect' && args[1]) {
    apiKey = args[1];
  } else if (cmd === '--key' && args[1]) {
    apiKey = args[1];
  }
  apiKey = apiKey || process.env.BUHDI_NODE_KEY || getApiKey();

  if (!apiKey) {
    console.error('❌ No API key provided. Use: buhdi-node setup <API_KEY>');
    process.exit(1);
  }

  // Save key if provided on CLI
  if (args[1] && (cmd === 'connect' || cmd === '--key')) {
    setApiKey(apiKey);
  }

  await runConnect(apiKey);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
