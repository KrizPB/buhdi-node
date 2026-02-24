/**
 * First-Run Wizard — Auto-detect and configure the node.
 * 
 * Detects: Ollama, system capabilities, existing config.
 * Returns a setup status object for the dashboard wizard UI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface WizardStatus {
  first_run: boolean;
  system: {
    os: string;
    arch: string;
    ram_gb: number;
    cpu: string;
    hostname: string;
  };
  ollama: {
    detected: boolean;
    url: string | null;
    models: string[];
    recommended_model: string | null;
    has_embedding_model: boolean;
  };
  config: {
    exists: boolean;
    has_api_key: boolean;
    has_llm: boolean;
    has_memory: boolean;
  };
  recommendations: string[];
}

const CHAT_MODELS = ['llama3.1:8b', 'llama3.2:3b', 'llama3.1:70b', 'mistral:7b', 'qwen2.5:7b', 'gemma2:9b', 'phi3:mini'];
const EMBEDDING_MODELS = ['nomic-embed-text', 'all-minilm', 'mxbai-embed-large'];

export async function runWizard(): Promise<WizardStatus> {
  const configDir = process.env.BUHDI_NODE_CONFIG_DIR || path.join(os.homedir(), '.buhdi-node');
  const configFile = path.join(configDir, 'config.json');

  // System info
  const system = {
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    ram_gb: Math.round(os.totalmem() / (1024 ** 3) * 10) / 10,
    cpu: os.cpus()[0]?.model || 'unknown',
    hostname: os.hostname(),
  };

  // Detect Ollama
  const ollama = await detectOllama();

  // Check config
  let configExists = false;
  let hasApiKey = false;
  let hasLlm = false;
  let hasMemory = false;
  try {
    if (fs.existsSync(configFile)) {
      configExists = true;
      const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
      hasApiKey = !!(config.apiKey_encrypted || config.apiKey);
      hasLlm = !!(config.llm?.providers?.length);
      hasMemory = config.memory?.enabled !== false;
    }
  } catch {}

  const firstRun = !configExists;

  // Build recommendations
  const recommendations: string[] = [];

  if (!ollama.detected) {
    recommendations.push('Install Ollama (https://ollama.com) for local AI — no cloud needed, fully private.');
  } else if (ollama.models.length === 0) {
    recommendations.push('Ollama is running but has no models. Run: ollama pull llama3.1:8b');
  } else if (!ollama.has_embedding_model) {
    recommendations.push(`Pull an embedding model for memory search: ollama pull nomic-embed-text`);
  }

  if (system.ram_gb < 8) {
    recommendations.push('With less than 8GB RAM, use smaller models (llama3.2:3b or phi3:mini).');
  } else if (system.ram_gb >= 32) {
    recommendations.push('Great RAM! You can run larger models like llama3.1:70b for better quality.');
  }

  if (!hasApiKey) {
    recommendations.push('Pair with mybuhdi.com for cloud sync, mobile access, and better models.');
  }

  if (recommendations.length === 0) {
    recommendations.push('Everything looks good! Your node is fully configured.');
  }

  return {
    first_run: firstRun,
    system,
    ollama,
    config: {
      exists: configExists,
      has_api_key: hasApiKey,
      has_llm: hasLlm,
      has_memory: hasMemory,
    },
    recommendations,
  };
}

async function detectOllama(): Promise<WizardStatus['ollama']> {
  const urls = ['http://localhost:11434', 'http://127.0.0.1:11434'];

  for (const url of urls) {
    try {
      const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!resp.ok) continue;

      const data = await resp.json() as { models?: Array<{ name: string; size: number }> };
      const models = (data.models || []).map((m: { name: string }) => m.name);

      const chatModel = CHAT_MODELS.find(m => models.some(installed => installed === m || installed.startsWith(m.split(':')[0])));
      const hasEmbedding = models.some(m => EMBEDDING_MODELS.some(em => m.startsWith(em)));

      return {
        detected: true,
        url,
        models,
        recommended_model: chatModel || models[0] || null,
        has_embedding_model: hasEmbedding,
      };
    } catch {
      continue;
    }
  }

  return { detected: false, url: null, models: [], recommended_model: null, has_embedding_model: false };
}

/**
 * Auto-configure: write a basic config.json if none exists.
 */
export async function autoConfig(): Promise<{ created: boolean; config_path: string; actions: string[] }> {
  const configDir = process.env.BUHDI_NODE_CONFIG_DIR || path.join(os.homedir(), '.buhdi-node');
  const configFile = path.join(configDir, 'config.json');

  if (fs.existsSync(configFile)) {
    return { created: false, config_path: configFile, actions: ['Config already exists'] };
  }

  // TOCTOU-FIX: Use exclusive flag to prevent race condition
  const writeExclusive = (p: string, data: string) => {
    const fd = fs.openSync(p, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fs.writeSync(fd, data);
    fs.closeSync(fd);
  };

  const ollama = await detectOllama();
  const actions: string[] = [];

  const config: any = {
    version: 2,
    healthPort: 9847,
    logLevel: 'info',
    trustLevel: 'approve_new',
  };

  // Auto-configure LLM if Ollama found
  if (ollama.detected && ollama.recommended_model) {
    config.llm = {
      strategy: 'local_only',
      providers: [{
        name: 'ollama',
        type: 'ollama',
        endpoint: ollama.url,
        model: ollama.recommended_model,
        priority: 1,
        capabilities: ['chat'],
        maxContext: 8192,
        enabled: true,
      }],
    };
    actions.push(`Configured Ollama (${ollama.recommended_model})`);
  }

  // Auto-configure memory
  config.memory = {
    enabled: true,
    embedding_model: ollama.has_embedding_model ? 'nomic-embed-text' : undefined,
    ollama_url: ollama.url || 'http://localhost:11434',
  };
  actions.push('Enabled local memory');

  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  try {
    writeExclusive(configFile, JSON.stringify(config, null, 2));
  } catch (e: any) {
    if (e.code === 'EEXIST') return { created: false, config_path: configFile, actions: ['Config already exists (race)'] };
    throw e;
  }
  actions.push(`Config saved to ${configFile}`);

  return { created: true, config_path: configFile, actions };
}
