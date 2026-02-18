import { exec } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { detectSystem, detectSoftware } from './handshake';

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

export class TaskExecutor {
  async execute(task: Task): Promise<TaskResult> {
    const start = Date.now();
    try {
      let result: any;
      switch (task.type) {
        case 'shell':
          result = await this.execShell(task.payload.command, task.payload.cwd);
          break;
        case 'file_read':
          result = await fs.readFile(task.payload.path, 'utf8');
          break;
        case 'file_write':
          await fs.writeFile(task.payload.path, task.payload.content);
          result = { written: task.payload.path };
          break;
        case 'system_info':
          result = { system: detectSystem(), software: detectSoftware() };
          break;
        case 'open_url':
          result = await this.openUrl(task.payload.url);
          break;
        case 'webcam':
          result = await this.captureWebcam(task.payload);
          break;
        case 'build_webpage':
          result = await this.buildWebpage(task.payload);
          break;
        case 'screenshot':
          result = await this.takeScreenshot();
          break;
        default:
          throw new Error(`Unknown task type: ${task.type}`);
      }
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`✅ Completed in ${elapsed}s`);
      return { status: 'completed', result };
    } catch (err: any) {
      console.log(`❌ Failed: ${err.message}`);
      return { status: 'failed', error: err.message };
    }
  }

  private execShell(command: string, cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd, timeout: 30000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      });
    });
  }

  private async openUrl(url: string): Promise<string> {
    const platform = os.platform();
    let cmd: string;
    if (platform === 'win32') cmd = `start "" "${url}"`;
    else if (platform === 'darwin') cmd = `open "${url}"`;
    else cmd = `xdg-open "${url}"`;
    await this.execShell(cmd);
    return `Opened ${url} in default browser`;
  }

  private async captureWebcam(payload: any): Promise<any> {
    const outDir = path.join(os.tmpdir(), 'buhdi-node');
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `webcam_${Date.now()}.jpg`);
    const platform = os.platform();

    if (platform === 'win32') {
      // Try ffmpeg first (most reliable)
      try {
        await this.execShell(
          `ffmpeg -f dshow -i video="Integrated Camera" -frames:v 1 -y "${outFile}" 2>&1`,
          undefined
        );
      } catch {
        // Try with generic device name
        try {
          await this.execShell(
            `ffmpeg -list_devices true -f dshow -i dummy 2>&1 || true`,
            undefined
          );
          // List devices and try first video device
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
          throw new Error(`Webcam capture failed. Ensure ffmpeg is installed and a camera is connected. ${e.message}`);
        }
      }
    } else if (platform === 'darwin') {
      // macOS: use ffmpeg with avfoundation
      await this.execShell(
        `ffmpeg -f avfoundation -framerate 30 -i "0" -frames:v 1 -y "${outFile}" 2>&1`
      );
    } else {
      // Linux: use ffmpeg with v4l2
      await this.execShell(
        `ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 -y "${outFile}" 2>&1`
      );
    }

    // Read the file and return base64
    const data = await fs.readFile(outFile);
    const base64 = data.toString('base64');
    // Clean up
    await fs.unlink(outFile).catch(() => {});
    return { 
      image: `data:image/jpeg;base64,${base64}`,
      size: data.length,
      message: 'Webcam photo captured successfully'
    };
  }

  private async buildWebpage(payload: any): Promise<any> {
    const { html, title, filename } = payload;
    const outDir = path.join(os.homedir(), 'Desktop');
    const fname = (filename || `${(title || 'page').replace(/[^a-zA-Z0-9]/g, '_')}.html`);
    const outFile = path.join(outDir, fname);

    // Write the HTML file
    await fs.writeFile(outFile, html, 'utf8');

    // Open in default browser
    await this.openUrl(outFile);

    return {
      path: outFile,
      message: `Webpage "${title || fname}" created and opened in browser`
    };
  }

  private async takeScreenshot(): Promise<any> {
    const outDir = path.join(os.tmpdir(), 'buhdi-node');
    await fs.mkdir(outDir, { recursive: true });
    const outFile = path.join(outDir, `screenshot_${Date.now()}.png`);
    const platform = os.platform();

    if (platform === 'win32') {
      // PowerShell screenshot
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
}
