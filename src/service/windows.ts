/**
 * Windows service management via Scheduled Tasks
 * 
 * Uses scheduled tasks instead of Windows Services because:
 * 1. Services run as LocalSystem which can't access user-encrypted config
 * 2. Services need "Log on as a service" rights (Group Policy hassle)
 * 3. Scheduled tasks run as the installing user natively
 * 4. No visible console window with S4U logon type
 */

import type { ServiceAction } from './install';
import { execSync } from 'child_process';
import path from 'path';
import os from 'os';

const TASK_NAME = 'BuhdiNode';

export async function windowsService(action: ServiceAction, nodePath: string, scriptPath: string): Promise<void> {
  const workDir = path.dirname(scriptPath);

  switch (action) {
    case 'install': {
      console.log('📦 Installing as Windows scheduled task...');

      // Remove existing task if present
      try {
        execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
      } catch {}

      // Build the PowerShell command to create the task with hidden window
      // Two triggers: at-logon + repeating every 5 minutes (self-healing)
      // The repeating trigger ensures the node restarts if it crashes.
      // The daemon itself handles duplicate detection via health port binding.
      const ps = `
        $action = New-ScheduledTaskAction -Execute '${nodePath.replace(/'/g, "''")}' -Argument '"${scriptPath.replace(/'/g, "''")}" daemon' -WorkingDirectory '${workDir.replace(/'/g, "''")}'
        $triggerLogon = New-ScheduledTaskTrigger -AtLogon
        $triggerRepeat = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 9999)
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365) -StartWhenAvailable -Hidden -MultipleInstances IgnoreNew
        $principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited
        Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $action -Trigger @($triggerLogon, $triggerRepeat) -Settings $settings -Principal $principal -Description 'Buhdi Node - connect your computer to your AI' -Force
      `.trim();

      try {
        const result = execSync(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, {
          encoding: 'utf8',
          timeout: 30000,
        });

        if (result.includes(TASK_NAME)) {
          console.log('✅ Scheduled task installed');
          console.log('   Task: ' + TASK_NAME);
          console.log('   Runs as: ' + process.env.USERNAME);
          console.log('   Starts at: logon (hidden, no console window)');
          console.log('   Auto-restart: every 1 minute on failure');

          // Start immediately
          try {
            execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe', timeout: 10000 });
            console.log('✅ Started');
          } catch {
            console.log('⚠️  Task registered but could not start. Try: schtasks /Run /TN "' + TASK_NAME + '"');
          }

          // Create desktop shortcut
          createDesktopShortcut();

          // Auto-open dashboard after a brief delay for the node to start
          setTimeout(() => {
            try {
              execSync('start http://localhost:9847/', { stdio: 'pipe', timeout: 5000 });
              console.log('🌐 Dashboard opened in browser');
            } catch {}
          }, 3000);
        } else {
          console.error('❌ Task registration did not return expected output');
          console.error(result);
        }
      } catch (err: any) {
        // If PowerShell fails (no admin), try schtasks as fallback
        console.warn('⚠️  PowerShell task creation needs admin privileges.');
        console.log('');
        console.log('Run this in an Administrator PowerShell:');
        console.log('');
        console.log(`  $action = New-ScheduledTaskAction -Execute "${nodePath}" -Argument '"${scriptPath}" daemon' -WorkingDirectory "${workDir}"`);
        console.log('  $trigger = New-ScheduledTaskTrigger -AtLogon');
        console.log('  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Days 365) -StartWhenAvailable -Hidden');
        console.log('  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERNAME" -LogonType S4U -RunLevel Limited');
        console.log(`  Register-ScheduledTask -TaskName "${TASK_NAME}" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Buhdi Node - connect your computer to your AI" -Force`);
        console.log(`  Start-ScheduledTask -TaskName "${TASK_NAME}"`);
      }
      break;
    }

    case 'uninstall': {
      try {
        execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe' });
      } catch {}
      try {
        execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, { stdio: 'pipe' });
        console.log('✅ Scheduled task removed');
      } catch {
        console.log('Task not found or already removed');
      }
      break;
    }

    case 'start': {
      try {
        execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe', timeout: 10000 });
        console.log('✅ Started');
      } catch {
        console.error('❌ Could not start. Is the task installed? Run: buhdi-node install');
      }
      break;
    }

    case 'stop': {
      try {
        execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe' });
        console.log('✅ Stopped');
      } catch {
        console.error('❌ Could not stop. Is the task running?');
      }
      break;
    }

    case 'restart': {
      try { execSync(`schtasks /End /TN "${TASK_NAME}"`, { stdio: 'pipe' }); } catch {}
      await new Promise(r => setTimeout(r, 2000));
      try {
        execSync(`schtasks /Run /TN "${TASK_NAME}"`, { stdio: 'pipe', timeout: 10000 });
        console.log('✅ Restarted');
      } catch {
        console.error('❌ Could not restart');
      }
      break;
    }

    case 'status': {
      try {
        const out = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO LIST`, { encoding: 'utf8', timeout: 10000 });
        console.log(out);
      } catch {
        console.log('Task not installed. Run: buhdi-node install');
      }
      break;
    }
  }
}

/**
 * Create a desktop shortcut to the Buhdi dashboard.
 * Uses PowerShell to create a .url file (internet shortcut) — no dependencies needed.
 */
function createDesktopShortcut(): void {
  try {
    const desktop = path.join(os.homedir(), 'Desktop');
    const shortcutPath = path.join(desktop, 'Buhdi.url');

    // .url file is a simple INI format — works on all Windows versions
    const content = [
      '[InternetShortcut]',
      'URL=http://localhost:9847/',
      'IconIndex=0',
      '',
    ].join('\r\n');

    require('fs').writeFileSync(shortcutPath, content, 'utf8');

    // Try to set a custom icon (favicon from the dashboard)
    // Fall back silently if it fails — the default browser icon is fine
    try {
      const iconPs = `
        $ws = New-Object -ComObject WScript.Shell;
        $sc = $ws.CreateShortcut('${desktop.replace(/'/g, "''")}\\Buhdi Dashboard.lnk');
        $sc.TargetPath = 'http://localhost:9847/';
        $sc.Description = 'Buhdi Node Dashboard';
        $sc.Save()
      `.trim();
      execSync(`powershell -NoProfile -Command "${iconPs.replace(/"/g, '\\"')}"`, {
        stdio: 'pipe',
        timeout: 10000,
      });
      // If .lnk succeeded, remove the .url version
      try { require('fs').unlinkSync(shortcutPath); } catch {}
      console.log('🖥️  Desktop shortcut created: Buhdi Dashboard');
    } catch {
      // .url fallback is already written
      console.log('🖥️  Desktop shortcut created: Buhdi.url');
    }
  } catch (err: any) {
    console.warn('⚠️  Could not create desktop shortcut:', err.message);
  }
}
