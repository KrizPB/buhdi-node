import { exec, spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import http from 'http';
import https from 'https';
import { detectSystem, detectSoftware } from './handshake';
import { decryptVaultSecret } from './vault';

export interface Task {
  id: string;
  type: string;
  payload: any;
}

export interface TaskResult {
  status: 'completed' | 'failed';
  result?: any;
  error?: string;
}

// --- Security: Dangerous command patterns ---
const BLOCKED_SHELL_PATTERNS = [
  /rm\s+(-rf?|--recursive)\s+[\/~]/i,
  /del\s+\/[sfq]/i,                        // Windows del /s /f /q
  /mkfs/i, /dd\s+if=/i, /format\s+[a-z]:/i,
  /:(){ :|:& };:/,                          // fork bomb
  />\s*\/dev\/sd/i,
  /curl.*\|\s*(ba)?sh/i, /wget.*\|\s*(ba)?sh/i,
  /powershell.*-enc/i,                      // encoded PS commands
  /net\s+user/i, /reg\s+(add|delete)/i,
  /shutdown/i, /reboot/i,
  /taskkill\s+\/f/i,
];

// --- Security: Sensitive file paths ---
const SENSITIVE_PATH_SEGMENTS = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker',
  'AppData/Local/Google/Chrome', 'AppData/Local/Microsoft/Edge',
  'AppData/Roaming/Mozilla/Firefox',
  '.config/gcloud', '.password-store',
  'id_rsa', 'id_ed25519', 'known_hosts',
  'credentials', 'tokens.json',
];

// --- Security: SSRF protection ---
const BLOCKED_HOSTS = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '[::1]', '::1'];
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

function isBlockedUrl(urlStr: string): string | null {
  try {
    const parsed = new URL(urlStr);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return 'Only HTTP/HTTPS URLs allowed';
    }
    if (BLOCKED_HOSTS.includes(parsed.hostname) || PRIVATE_IP_RE.test(parsed.hostname)) {
      return 'Blocked: internal/private network URL';
    }
    return null;
  } catch {
    return 'Invalid URL';
  }
}

const WORKSPACE_ROOT = process.env.BUHDI_WORKSPACE || process.cwd();

function validateFilePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const normalized = resolved.replace(/\\/g, '/').toLowerCase();
  for (const seg of SENSITIVE_PATH_SEGMENTS) {
    if (normalized.includes(seg.toLowerCase())) {
      throw new Error(`Access denied: path contains sensitive segment '${seg}'`);
    }
  }
  // Workspace jail
  const workspaceNorm = path.resolve(WORKSPACE_ROOT).replace(/\\/g, '/').toLowerCase();
  if (!normalized.startsWith(workspaceNorm)) {
    throw new Error('Access denied: path outside workspace');
  }
  return resolved;
}

export class TaskExecutor {
  private apiKey: string = '';

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  /** Resolve vault_refs in task payload — decrypt secrets and inject into env/command */
  private async resolveVaultRefs(task: Task): Promise<Record<string, string>> {
    const decrypted: Record<string, string> = {};
    const vaultRefs = task.payload?.vault_refs;
    if (!vaultRefs || !Array.isArray(vaultRefs) || vaultRefs.length === 0) return decrypted;

    try {
      // Fetch encrypted secrets from cloud
      const res = await fetch('https://www.mybuhdi.com/api/node/vault/secrets', {
        headers: { 'x-node-key': this.apiKey },
      });
      if (!res.ok) {
        console.warn('⚠️  Failed to fetch vault secrets');
        return decrypted;
      }
      const { data: secrets } = await res.json() as any;
      if (!secrets) return decrypted;

      // Build lookup by name
      const secretMap = new Map<string, any>();
      for (const s of secrets) {
        secretMap.set(s.name, s);
      }

      // Decrypt each referenced secret
      for (const ref of vaultRefs) {
        const secret = secretMap.get(ref);
        if (!secret || !secret.node_encrypted_key) {
          console.warn(`⚠️  Vault ref "${ref}" not found or no node key`);
          continue;
        }
        try {
          const value = await decryptVaultSecret(
            secret.encrypted_value,
            secret.iv,
            secret.auth_tag,
            secret.node_encrypted_key
          );
          decrypted[ref] = value;
        } catch (err: any) {
          // LOW-3: Don't leak crypto internals
          console.warn(`⚠️  Failed to decrypt vault ref "${ref}": ${err.message}`);
        }
      }
    } catch (err: any) {
      console.warn('⚠️  Vault resolution error:', err.message);
    }

    return decrypted;
  }

  /** Build environment variables for vault secrets (HIGH-3: inject as env vars, not into command strings) */
  private buildVaultEnv(secrets: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(secrets)) {
      // Convert secret name to env var: VAULT_<UPPERCASE_NAME>
      const envKey = `VAULT_${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
      env[envKey] = value;
    }
    return env;
  }

  /** Mask any vault secret values in output text (HIGH-3: prevent secret leakage in logs/results) */
  private maskSecrets(text: string, secrets: Record<string, string>): string {
    let masked = text;
    for (const value of Object.values(secrets)) {
      if (value && value.length >= 4) {
        // Replace all occurrences of the secret value
        masked = masked.split(value).join('[REDACTED]');
      }
    }
    return masked;
  }

  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();
    let vaultSecrets: Record<string, string> = {};
    try {
      // Resolve vault refs if present
      if (task.payload?.vault_refs) {
        vaultSecrets = await this.resolveVaultRefs(task);
        // HIGH-3: Do NOT substitute secrets into command strings.
        // Instead, they are injected as environment variables (VAULT_<NAME>)
        // and any {{vault:name}} placeholders are stripped from the command.
        if (task.payload.command) {
          task.payload.command = task.payload.command.replace(
            /\{\{vault:([^}]+)\}\}/g,
            (_match: string, name: string) => {
              const envKey = `VAULT_${name.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
              // Replace with env var reference appropriate to shell
              return os.platform() === 'win32' ? `$env:${envKey}` : `$${envKey}`;
            }
          );
        }
      }

      // HIGH-3: Build vault env vars for shell commands
      const vaultEnv = this.buildVaultEnv(vaultSecrets);

      let result: any;
      switch (task.type) {
        case 'shell':
          result = await this.execShell(task.payload.command, task.payload.cwd, vaultEnv);
          break;
        case 'file_read':
          result = await this.fileRead(task.payload.path);
          break;
        case 'file_write':
          result = await this.fileWrite(task.payload.path, task.payload.content);
          break;
        case 'system_info':
          result = { system: detectSystem(), software: detectSoftware() };
          break;
        case 'open_url':
          result = await this.openUrl(task.payload.url);
          break;
        case 'webcam':
          console.log('⚠️  WEBCAM CAPTURE REQUESTED');
          result = await this.captureWebcam(task.payload);
          break;
        case 'build_webpage':
          result = await this.buildWebpage(task.payload);
          break;
        case 'screenshot':
          console.log('⚠️  SCREENSHOT REQUESTED');
          result = await this.takeScreenshot();
          break;
        case 'web_search':
          result = await this.webSearch(task.payload.query, task.payload.count);
          break;
        case 'web_fetch':
          result = await this.webFetch(task.payload.url, task.payload.maxChars);
          break;
        case 'status_ping':
          result = await this.statusPing(task.payload);
          break;

        // --- Pipeline command handlers ---
        case 'run-build': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          result = await this.execCommand('npm', ['run', 'build'], cwd, vaultEnv);
          break;
        }
        case 'run-test': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          result = await this.execCommand('npm', ['test'], cwd, vaultEnv);
          break;
        }
        case 'write-file': {
          const args = task.payload.args || task.payload;
          result = await this.fileWrite(args.path, args.content);
          break;
        }
        case 'read-file': {
          const args = task.payload.args || task.payload;
          result = await this.fileRead(args.path);
          break;
        }
        case 'git-status': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          result = await this.execCommand('git', ['status', '--porcelain'], cwd, vaultEnv);
          break;
        }
        case 'git-commit': {
          const args = task.payload.args || task.payload;
          const cwd = validateFilePath(args.cwd);
          const sanitizedMessage = String(args.message || 'auto-commit').slice(0, 200);
          await this.execCommand('git', ['add', '.'], cwd, vaultEnv);
          result = await this.execCommand('git', ['commit', '-m', sanitizedMessage], cwd, vaultEnv);
          break;
        }
        case 'git-push': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          result = await this.execCommand('git', ['push'], cwd, vaultEnv);
          break;
        }
        case 'deploy': {
          const args = task.payload.args || task.payload;
          const hookUrl = args.deployHookUrl;
          if (!hookUrl || !hookUrl.startsWith('https://')) {
            throw new Error('deploy requires an HTTPS deployHookUrl');
          }
          const blocked = isBlockedUrl(hookUrl);
          if (blocked) throw new Error(blocked);
          result = await this.httpPost(hookUrl);
          break;
        }
        case 'list-files': {
          const args = task.payload.args || task.payload;
          const cwd = validateFilePath(args.cwd);
          const depth = Math.min(Math.max(Number(args.depth) || 3, 1), 5);
          result = await this.listFilesTree(cwd, depth);
          break;
        }
        case 'install-deps': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          // Use npm ci if lockfile exists, otherwise npm install
          let npmArgs = ['install'];
          try {
            await fs.access(path.join(cwd, 'package-lock.json'));
            npmArgs = ['ci'];
          } catch {}
          result = await this.execCommand('npm', npmArgs, cwd, vaultEnv);
          break;
        }
        case 'lint': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          result = await this.execCommand('npm', ['run', 'lint'], cwd, vaultEnv);
          break;
        }
        case 'format': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          result = await this.execCommand('npm', ['run', 'format'], cwd, vaultEnv);
          break;
        }
        case 'npm-audit': {
          const cwd = validateFilePath(task.payload.args?.cwd || task.payload.cwd);
          result = await this.npmAudit(cwd);
          break;
        }

        default: {
          // Handle cmd:category:operation tasks from capability matrix
          if (task.type.startsWith('cmd:')) {
            const { category, operation, args: cmdArgs, timeout: cmdTimeout } = task.payload;
            result = await this.executeCmdTask(category, operation, cmdArgs, cmdTimeout, vaultEnv);
          } else {
            throw new Error(`Unknown task type: ${task.type}`);
          }
        }
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`✅ Completed in ${elapsed}s`);

      // HIGH-3: Mask any vault secret values from the result before returning
      if (Object.keys(vaultSecrets).length > 0) {
        if (typeof result === 'string') {
          result = this.maskSecrets(result, vaultSecrets);
        } else if (result && typeof result === 'object') {
          // Deep mask string fields
          const jsonStr = JSON.stringify(result);
          result = JSON.parse(this.maskSecrets(jsonStr, vaultSecrets));
        }
      }

      const taskResult: TaskResult = { status: 'completed', result };
      if (Object.keys(vaultSecrets).length > 0) {
        (taskResult as any).vault_used = true;
      }
      return taskResult;
    } catch (err: any) {
      // LOW-3: Catch crypto/vault errors and return generic messages
      const errorMsg = err.message || String(err);
      const isVaultError = errorMsg.includes('decrypt') || errorMsg.includes('Vault') || errorMsg.includes('OAEP') || errorMsg.includes('cipher');
      if (isVaultError) {
        console.error(`❌ Vault error (details suppressed from result):`, errorMsg);
        return { status: 'failed', error: 'Vault decryption failed' };
      }
      // Mask any vault secrets from error messages too
      const maskedError = Object.keys(vaultSecrets).length > 0
        ? this.maskSecrets(errorMsg, vaultSecrets)
        : errorMsg;
      console.log(`❌ Failed: ${maskedError}`);
      return { status: 'failed', error: maskedError };
    }
  }

  private async executeCmdTask(category: string, operation: string, args: string, timeout: number, vaultEnv?: Record<string, string>): Promise<any> {
    console.log(`🔧 CMD: ${category}:${operation} | ${args.slice(0, 100)}`);

    switch (category) {
      case 'file':
        switch (operation) {
          case 'read': return this.fileRead(args);
          case 'write': {
            // args format: "path|content"
            const sep = args.indexOf('|');
            if (sep === -1) throw new Error('file:write requires path|content');
            return this.fileWrite(args.slice(0, sep), args.slice(sep + 1));
          }
          case 'list': return this.listFilesTree(validateFilePath(args || WORKSPACE_ROOT), 3);
          case 'search': {
            const dir = validateFilePath(args.split('|')[0] || WORKSPACE_ROOT);
            const pattern = args.split('|')[1] || '*';
            return this.execCommand(
              os.platform() === 'win32' ? 'powershell' : 'find',
              os.platform() === 'win32'
                ? ['-c', `Get-ChildItem -Recurse -Path "${dir}" -Filter "${pattern}" | Select-Object -First 20 | ForEach-Object { $_.FullName }`]
                : [dir, '-name', pattern, '-maxdepth', '4', '-type', 'f'],
              undefined, vaultEnv
            );
          }
          case 'move': {
            const parts = args.split('|');
            if (parts.length < 2) throw new Error('file:move requires source|destination');
            const src = validateFilePath(parts[0]);
            const dst = validateFilePath(parts[1]);
            await fs.rename(src, dst);
            return { moved: { from: src, to: dst } };
          }
          case 'delete': {
            const target = validateFilePath(args);
            await fs.unlink(target);
            return { deleted: target };
          }
          default: throw new Error(`Unknown file operation: ${operation}`);
        }

      case 'git':
        switch (operation) {
          case 'status': return this.execCommand('git', ['status', '--porcelain'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'diff': return this.execCommand('git', ['diff', '--stat'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'log': return this.execCommand('git', ['log', '--oneline', '-20'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'commit': {
            const parts = args.split('|');
            const cwd = validateFilePath(parts[0] || WORKSPACE_ROOT);
            const msg = (parts[1] || 'auto-commit').slice(0, 200);
            await this.execCommand('git', ['add', '.'], cwd, vaultEnv);
            return this.execCommand('git', ['commit', '-m', msg], cwd, vaultEnv);
          }
          case 'push': return this.execCommand('git', ['push'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'pull': return this.execCommand('git', ['pull'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'branch': return this.execCommand('git', ['branch', '-a'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'stash': return this.execCommand('git', ['stash'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'rebase': return this.execCommand('git', ['rebase', args.split('|')[1] || 'main'], validateFilePath(args.split('|')[0] || WORKSPACE_ROOT), vaultEnv);
          case 'force-push': return this.execCommand('git', ['push', '--force-with-lease'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          default: throw new Error(`Unknown git operation: ${operation}`);
        }

      case 'deploy':
        switch (operation) {
          case 'hook': {
            if (!args.startsWith('https://')) throw new Error('Deploy hook must be HTTPS');
            const blocked = isBlockedUrl(args);
            if (blocked) throw new Error(blocked);
            return this.httpPost(args);
          }
          case 'status': return this.execCommand('vercel', ['list', '--yes'], undefined, vaultEnv);
          case 'env-list': return this.execCommand('vercel', ['env', 'ls'], undefined, vaultEnv);
          case 'env-set': {
            // args format: "KEY=VALUE" or "KEY=VALUE --environment production"
            const eqIdx = args.indexOf('=');
            if (eqIdx === -1) throw new Error('env-set requires KEY=VALUE');
            const key = args.slice(0, eqIdx);
            const value = args.slice(eqIdx + 1);
            // Use vercel env add with stdin
            return new Promise((resolve, reject) => {
              const child = spawn('vercel', ['env', 'add', key, 'production', '--yes'], {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
              });
              let out = '';
              child.stdout.on('data', (d: Buffer) => out += d);
              child.stderr.on('data', (d: Buffer) => out += d);
              child.on('close', (code: number | null) => {
                if (code !== 0) reject(new Error(out || `Exit ${code}`));
                else resolve({ set: key, environment: 'production', output: out });
              });
              child.on('error', reject);
              child.stdin.write(value);
              child.stdin.end();
              setTimeout(() => { child.kill(); reject(new Error('Timeout')); }, 30000);
            });
          }
          case 'env-remove': return this.execCommand('vercel', ['env', 'rm', args, '--yes'], undefined, vaultEnv);
          case 'deploy': return this.execCommand('vercel', ['--prod', '--yes'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'promote': return this.execCommand('vercel', ['promote', args, '--yes'], undefined, vaultEnv);
          default: throw new Error(`Unknown deploy operation: ${operation}`);
        }

      case 'shell':
        return this.execShell(args, undefined, vaultEnv);

      case 'package':
        switch (operation) {
          case 'audit': return this.npmAudit(validateFilePath(args || WORKSPACE_ROOT));
          case 'list': return this.execCommand('npm', ['list', '--depth=0'], validateFilePath(args || WORKSPACE_ROOT), vaultEnv);
          case 'install': return this.execCommand('npm', ['install', ...args.split(/\s+/)], undefined, vaultEnv);
          case 'update': return this.execCommand('npm', ['update', ...args.split(/\s+/)], undefined, vaultEnv);
          case 'uninstall': return this.execCommand('npm', ['uninstall', ...args.split(/\s+/)], undefined, vaultEnv);
          default: throw new Error(`Unknown package operation: ${operation}`);
        }

      case 'browser':
        switch (operation) {
          case 'screenshot': return this.takeScreenshot();
          case 'navigate': return this.openUrl(args);
          default: throw new Error(`Unknown browser operation: ${operation}`);
        }

      case 'sql':
        // SQL execution via supabase-sql.py or direct psql
        return this.execShell(`python scripts/supabase-sql.py "${args.replace(/"/g, '\\"')}"`, WORKSPACE_ROOT, vaultEnv);

      case 'process':
        switch (operation) {
          case 'list':
            return this.execShell(
              os.platform() === 'win32' ? 'tasklist /fo csv /nh' : 'ps aux --sort=-pcpu | head -20',
              undefined, vaultEnv
            );
          case 'start': return this.execShell(args, undefined, vaultEnv);
          case 'stop':
          case 'kill':
            return this.execShell(
              os.platform() === 'win32' ? `taskkill /pid ${args} /f` : `kill ${args}`,
              undefined, vaultEnv
            );
          default: throw new Error(`Unknown process operation: ${operation}`);
        }

      case 'ssh':
        return this.execShell(`ssh ${args}`, undefined, vaultEnv);

      default:
        throw new Error(`Unknown capability category: ${category}`);
    }
  }

  private execCommand(cmd: string, args: string[], cwd?: string, vaultEnv?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
      const env = vaultEnv && Object.keys(vaultEnv).length > 0
        ? { ...process.env, ...vaultEnv }
        : undefined;
      const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => stdout += d);
      child.stderr.on('data', (d: Buffer) => stderr += d);
      child.on('close', (code: number | null) => {
        if (code !== 0) reject(new Error(stderr || `Exit code ${code}`));
        else resolve(stdout);
      });
      child.on('error', reject);
      setTimeout(() => { child.kill(); reject(new Error('Command timeout')); }, 30000);
    });
  }

  private execShell(command: string, cwd?: string, vaultEnv?: Record<string, string>): Promise<string> {
    // Security: block dangerous patterns
    for (const pat of BLOCKED_SHELL_PATTERNS) {
      if (pat.test(command)) {
        return Promise.reject(new Error(`Blocked dangerous command pattern: ${command.slice(0, 80)}`));
      }
    }
    // Security: block attempts to exfiltrate env vars (also block VAULT_ exfil)
    if (/\b(BRAVE_API_KEY|BUHDI_API_KEY|API_KEY|SECRET|TOKEN|PASSWORD|VAULT_)\b/i.test(command) &&
        /(echo|print|cat|type|set|env|Get-ChildItem\s+env)/i.test(command)) {
      return Promise.reject(new Error('Blocked: potential credential exfiltration'));
    }

    console.log(`🔧 Shell: ${command.slice(0, 120)}${command.length > 120 ? '...' : ''}`);
    return new Promise((resolve, reject) => {
      // HIGH-3: Inject vault secrets as environment variables instead of command string substitution
      const env = vaultEnv && Object.keys(vaultEnv).length > 0
        ? { ...process.env, ...vaultEnv }
        : undefined;
      exec(command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true, env }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  // --- Secured file operations ---
  private async fileRead(filePath: string): Promise<string> {
    const safe = validateFilePath(filePath);
    console.log(`📄 Reading: ${safe}`);
    const stat = await fs.stat(safe);
    if (stat.size > 10 * 1024 * 1024) throw new Error('File too large (>10MB)');
    return await fs.readFile(safe, 'utf8');
  }

  private async fileWrite(filePath: string, content: string): Promise<any> {
    const safe = validateFilePath(filePath);
    if (content.length > 10 * 1024 * 1024) throw new Error('Content too large (>10MB)');
    console.log(`📝 Writing: ${safe}`);
    await fs.writeFile(safe, content);
    return { written: safe };
  }

  // --- Secured URL opening (no shell injection) ---
  private async openUrl(url: string): Promise<string> {
    const blocked = isBlockedUrl(url);
    if (blocked) throw new Error(blocked);

    const platform = os.platform();
    console.log(`🌐 Opening: ${url}`);
    if (platform === 'win32') {
      spawn('explorer', [url], { shell: false, detached: true, stdio: 'ignore', windowsHide: true });
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' });
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    }
    return `Opened ${url} in default browser`;
  }

  private async captureWebcam(payload: any): Promise<any> {
    const outDir = path.join(os.tmpdir(), 'buhdi-node');
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `webcam_${Date.now()}.jpg`);
    const platform = os.platform();

    if (platform === 'win32') {
      try {
        await this.execShell(
          `ffmpeg -f dshow -i video="Integrated Camera" -frames:v 1 -y "${outFile}" 2>&1`,
          undefined
        );
      } catch {
        try {
          const devices = await this.execShell(
            `powershell -c "Get-PnpDevice -Class Camera -Status OK | Select-Object -ExpandProperty FriendlyName"`,
            undefined
          );
          const deviceName = devices.trim().split('\n')[0]?.trim();
          if (deviceName) {
            await this.execShell(
              `ffmpeg -f dshow -i video="${deviceName}" -frames:v 1 -y "${outFile}" 2>&1`,
              undefined
            );
          } else {
            throw new Error('No camera device found');
          }
        } catch (e: any) {
          throw new Error(`Webcam capture failed. Ensure ffmpeg is installed. ${e.message}`);
        }
      }
    } else if (platform === 'darwin') {
      await this.execShell(
        `ffmpeg -f avfoundation -framerate 30 -i "0" -frames:v 1 -y "${outFile}" 2>&1`
      );
    } else {
      await this.execShell(
        `ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 -y "${outFile}" 2>&1`
      );
    }

    const data = await fs.readFile(outFile);
    const base64 = data.toString('base64');
    await fs.unlink(outFile).catch(() => {});
    return { 
      image: `data:image/jpeg;base64,${base64}`,
      size: data.length,
      message: 'Webcam photo captured successfully'
    };
  }

  private async buildWebpage(payload: any): Promise<any> {
    const { html, title, filename } = payload;
    // CRITICAL: Write to workspace, not arbitrary Desktop path
    const outDir = path.join(WORKSPACE_ROOT, 'buhdi-pages');
    // Security: sanitize filename — strip path separators and dangerous chars
    const rawName = (filename || `${(title || 'page').replace(/[^a-zA-Z0-9]/g, '_')}.html`);
    const safeName = path.basename(rawName).replace(/[^a-zA-Z0-9._-]/g, '_');
    const outFile = path.join(outDir, safeName);
    // Validate it stays in workspace
    validateFilePath(outFile);

    console.log(`🏗️ Building webpage: ${outFile}`);
    await fs.writeFile(outFile, html, 'utf8');
    await this.openUrl(outFile);

    return {
      path: outFile,
      message: `Webpage "${title || safeName}" created and opened in browser`
    };
  }

  private async takeScreenshot(): Promise<any> {
    const outDir = path.join(os.tmpdir(), 'buhdi-node');
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `screenshot_${Date.now()}.png`);
    const platform = os.platform();

    if (platform === 'win32') {
      const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($screen.Width, $screen.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save('${outFile.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
`.trim();
      await this.execShell(`powershell -c "${psScript.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`);
    } else if (platform === 'darwin') {
      await this.execShell(`screencapture -x "${outFile}"`);
    } else {
      await this.execShell(`import -window root "${outFile}" || scrot "${outFile}"`);
    }

    const data = await fs.readFile(outFile);
    const base64 = data.toString('base64');
    await fs.unlink(outFile).catch(() => {});
    return {
      image: `data:image/png;base64,${base64}`,
      size: data.length,
      message: 'Screenshot captured successfully'
    };
  }

  private async statusPing(payload: any): Promise<any> {
    const uptime = os.uptime();
    const loadavg = os.loadavg();
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    return {
      pong: true,
      agent_task_id: payload?.agent_task_id,
      timestamp: new Date().toISOString(),
      system: {
        uptime_hours: Math.round(uptime / 3600 * 10) / 10,
        load_avg: loadavg,
        memory_used_pct: Math.round((1 - freeMem / totalMem) * 100),
        free_mem_mb: Math.round(freeMem / 1024 / 1024),
      },
      message: 'Node is alive and processing',
    };
  }

  // --- Deploy hook POST ---
  private httpPost(url: string): Promise<any> {
    const blocked = isBlockedUrl(url);
    if (blocked) return Promise.reject(new Error(blocked));
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = https.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: 'POST', headers: { 'Content-Length': '0' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => body += c);
        res.on('end', () => resolve({ status: res.statusCode, body: body.slice(0, 2000) }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Deploy request timeout')); });
      req.end();
    });
  }

  // --- List files as tree ---
  private async listFilesTree(dir: string, maxDepth: number, currentDepth: number = 0): Promise<any> {
    if (currentDepth >= maxDepth) return '[max depth]';
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const tree: Record<string, any> = {};
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      if (entry.isDirectory()) {
        tree[entry.name + '/'] = await this.listFilesTree(path.join(dir, entry.name), maxDepth, currentDepth + 1);
      } else {
        tree[entry.name] = null;
      }
    }
    return tree;
  }

  // --- NPM audit with structured output ---
  private async npmAudit(cwd: string): Promise<any> {
    let stdout = '';
    try {
      stdout = await this.execCommand('npm', ['audit', '--json'], cwd);
    } catch (err: any) {
      // npm audit exits non-zero when vulns found — parse stdout from error
      stdout = err.message || '';
    }
    try {
      const parsed = JSON.parse(stdout);
      const advisories = Object.values(parsed.vulnerabilities || parsed.advisories || {});
      return {
        summary: parsed.metadata || { total: advisories.length },
        advisories: advisories.slice(0, 20),
      };
    } catch {
      return { raw: stdout.slice(0, 5000) };
    }
  }

  // --- Secured HTTP client with redirect limits and SSRF protection ---
  private httpGet(url: string, headers?: Record<string, string>, maxRedirects: number = 5): Promise<{ status: number; body: string }> {
    const blocked = isBlockedUrl(url);
    if (blocked) return Promise.reject(new Error(blocked));
    if (maxRedirects <= 0) return Promise.reject(new Error('Too many redirects'));

    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.get(url, { headers: headers || {} }, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this.httpGet(res.headers.location, headers, maxRedirects - 1).then(resolve).catch(reject);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => resolve({ status: res.statusCode || 200, body }));
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
  }

  private async webSearch(query: string, count?: number): Promise<any> {
    const numResults = Math.min(count || 5, 10);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${numResults}`;
    const apiKey = process.env.BRAVE_API_KEY;
    if (!apiKey) throw new Error('BRAVE_API_KEY not set. Export it before running buhdi-node.');

    const { body } = await this.httpGet(url, {
      'Accept': 'application/json',
      'X-Subscription-Token': apiKey
    });

    const data = JSON.parse(body);
    const results = (data.web?.results || []).map((r: any) => ({
      title: r.title,
      url: r.url,
      description: r.description
    }));
    return { query, results, total: results.length };
  }

  private async webFetch(url: string, maxChars?: number): Promise<any> {
    const limit = maxChars || 50000;
    const { status, body } = await this.httpGet(url, {
      'User-Agent': 'BuhdiNode/0.1'
    });

    let text = body
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    if (text.length > limit) text = text.substring(0, limit) + '... [truncated]';

    return { url, status, length: text.length, content: text };
  }
}
