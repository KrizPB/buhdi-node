import { execSync } from 'child_process';
import os from 'os';

const BASE_URL = 'https://www.mybuhdi.com';

interface ScanResult {
  tool_name: string;
  detected: boolean;
  version?: string;
}

function getPlatform(): 'windows' | 'mac' | 'linux' {
  const p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

// SECURITY: Detection commands are hardcoded on the node, NEVER fetched from cloud.
// This prevents command injection via a compromised API/catalog.
// Only simple "which"/"where" commands are used — no arbitrary execution.
const DETECTION_MAP: Record<string, Record<string, string>> = {
  git: { windows: 'where git', mac: 'which git', linux: 'which git' },
  vercel: { windows: 'where vercel', mac: 'which vercel', linux: 'which vercel' },
  docker: { windows: 'where docker', mac: 'which docker', linux: 'which docker' },
  aws_cli: { windows: 'where aws', mac: 'which aws', linux: 'which aws' },
  npm: { windows: 'where npm', mac: 'which npm', linux: 'which npm' },
  node: { windows: 'where node', mac: 'which node', linux: 'which node' },
  python: { windows: 'where python', mac: 'which python3', linux: 'which python3' },
  database_cli: { windows: 'where psql', mac: 'which psql', linux: 'which psql' },
  api_tester: { windows: 'where curl', mac: 'which curl', linux: 'which curl' },
  ssh: { windows: 'where ssh', mac: 'which ssh', linux: 'which ssh' },
};

function tryDetect(command: string): { found: boolean; version?: string } {
  try {
    const output = execSync(command, {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }).toString().trim();
    return { found: output.length > 0, version: undefined };
  } catch {
    return { found: false };
  }
}

export async function scanTools(apiKey: string): Promise<void> {
  const platform = getPlatform();

  // Fetch tool catalog from cloud (for tool names only — NOT detection commands)
  let catalogToolNames: string[];
  try {
    const res = await fetch(`${BASE_URL}/api/tools`);
    if (!res.ok) {
      console.warn('⚠️  Could not fetch tool catalog for scanning');
      return;
    }
    const json = await res.json() as any;
    catalogToolNames = [];
    for (const category of Object.values(json.data || {})) {
      for (const tool of category as any[]) {
        if (tool.requires_node) {
          catalogToolNames.push(tool.name);
        }
      }
    }
  } catch (err: any) {
    console.warn('⚠️  Tool catalog fetch failed:', err.message);
    return;
  }

  if (catalogToolNames.length === 0) return;

  console.log(`🔍 Scanning for tools...`);
  const results: ScanResult[] = [];

  for (const toolName of catalogToolNames) {
    // Only run detection if we have a hardcoded command for this tool
    const commands = DETECTION_MAP[toolName];
    if (!commands || !commands[platform]) {
      // Tool exists in catalog but we don't have a local detection command
      // Report as not detected (safe default)
      results.push({ tool_name: toolName, detected: false });
      continue;
    }
    const { found, version } = tryDetect(commands[platform]);
    results.push({ tool_name: toolName, detected: found, version });
    if (found) console.log(`   ✅ ${toolName}`);
  }

  const detected = results.filter((r) => r.detected).length;
  console.log(`🔧 Found ${detected}/${results.length} tools`);

  // Report to cloud
  try {
    const res = await fetch(`${BASE_URL}/api/node/tools/scan`, {
      method: 'POST',
      headers: {
        'x-node-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ results }),
    });
    if (res.ok) {
      console.log('📤 Tool scan reported to cloud');
    }
  } catch (err: any) {
    console.warn('⚠️  Failed to report tool scan:', err.message);
  }
}
