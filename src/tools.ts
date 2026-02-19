import { execSync } from 'child_process';
import os from 'os';

const BASE_URL = 'https://www.mybuhdi.com';

interface ToolCatalogEntry {
  name: string;
  detection_commands: Record<string, string>;
  requires_node: boolean;
}

interface ScanResult {
  tool_name: string;
  detected: boolean;
  version?: string;
}

function getPlatform(): string {
  const p = os.platform();
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'mac';
  return 'linux';
}

function tryDetect(command: string): { found: boolean; version?: string } {
  try {
    const output = execSync(command, { timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] })
      .toString()
      .trim();
    return { found: output.length > 0, version: undefined };
  } catch {
    return { found: false };
  }
}

export async function scanTools(apiKey: string): Promise<void> {
  const platform = getPlatform();

  // Fetch tool catalog from cloud
  let catalog: ToolCatalogEntry[];
  try {
    const res = await fetch(`${BASE_URL}/api/tools`);
    if (!res.ok) {
      console.warn('⚠️  Could not fetch tool catalog for scanning');
      return;
    }
    const json = await res.json() as any;
    // Flatten grouped data
    catalog = [];
    for (const category of Object.values(json.data || {})) {
      for (const tool of category as any[]) {
        if (tool.requires_node && tool.detection_commands) {
          catalog.push({
            name: tool.name,
            detection_commands: tool.detection_commands,
            requires_node: tool.requires_node,
          });
        }
      }
    }
  } catch (err: any) {
    console.warn('⚠️  Tool catalog fetch failed:', err.message);
    return;
  }

  if (catalog.length === 0) return;

  console.log(`🔍 Scanning for ${catalog.length} tools...`);
  const results: ScanResult[] = [];

  for (const tool of catalog) {
    const cmd = tool.detection_commands[platform];
    if (!cmd) {
      results.push({ tool_name: tool.name, detected: false });
      continue;
    }
    const { found, version } = tryDetect(cmd);
    results.push({ tool_name: tool.name, detected: found, version });
    if (found) console.log(`   ✅ ${tool.name}`);
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
