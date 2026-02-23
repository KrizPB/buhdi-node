# Buhdi Node — Installation Guide

## Quick Start

### 1. Install

```bash
npm install -g buhdi-node
```

Or clone and build:

```bash
git clone https://github.com/buhdi-built-it/buhdi-node.git
cd buhdi-node
npm install
npm run build
```

### 2. Setup

```bash
buhdi-node setup <YOUR_API_KEY>
```

Your API key is on your mybuhdi.com dashboard → Settings → Node Key.

This encrypts and stores your key locally at `~/.buhdi-node/config.json`.

### 3. Test

```bash
buhdi-node daemon
```

You should see:

```
🔌 Connecting via WebSocket...
✅ WebSocket connected as "Your Computer Name"
🏥 Health: http://localhost:9847/
```

Press Ctrl+C to stop. If it connects, you're ready to install as a background service.

### 4. Install as Background Service

```bash
buhdi-node install
```

**What this does:**
- **Windows:** Creates a scheduled task (hidden, no console window)
- **macOS:** Creates a LaunchAgent
- **Linux:** Creates a systemd user service

The node starts automatically on login and restarts if it crashes.

> **Windows note:** If you see "needs admin privileges", open PowerShell as Administrator and run the commands it prints.

### 5. Verify

Open your browser to **http://localhost:9847/** — you should see the Buhdi dashboard.

On mybuhdi.com, your node should show as online.

---

## Commands

| Command | Description |
|---------|-------------|
| `buhdi-node setup <KEY>` | Configure your API key |
| `buhdi-node daemon` | Run in foreground (for testing) |
| `buhdi-node install` | Install as background service |
| `buhdi-node uninstall` | Remove background service |
| `buhdi-node start` | Start the service |
| `buhdi-node stop` | Stop the service |
| `buhdi-node restart` | Restart the service |
| `buhdi-node status` | Check service status |
| `buhdi-node plugins` | List installed plugins |

---

## Dashboard

Once running, open **http://localhost:9847/** in your browser:

- **💬 Chat** — Talk to your AI directly
- **📊 Dashboard** — Connection status, tasks, system info
- **📋 Jobs** — Running and completed tasks
- **🔧 Tools** — 64+ tools your AI can use (configure credentials here)
- **📖 Config** — Edit your AI's personality and settings
- **⚙️ Settings** — Connection and node configuration

---

## File Locations

| What | Where |
|------|-------|
| Config | `~/.buhdi-node/config.json` |
| Logs | `~/.buhdi-node/logs/buhdi-node-YYYY-MM-DD.log` |
| Vault (credentials) | `~/.buhdi-node/vault/` |
| Dashboard token | In config.json (shown once during setup) |

---

## Troubleshooting

### Node shows offline on mybuhdi.com

1. Check if the process is running:
   - Windows: `schtasks /Query /TN "BuhdiNode" /FO LIST`
   - macOS: `launchctl list | grep buhdi`
   - Linux: `systemctl --user status buhdi-node`

2. Check logs at `~/.buhdi-node/logs/`

3. Try running manually: `buhdi-node daemon` — watch for errors

### "No API key" error

Your config is missing or corrupted. Re-run:
```bash
buhdi-node setup <YOUR_API_KEY>
```

### Port 9847 already in use

Another instance is running. Kill it:
- Windows: `taskkill /F /FI "WINDOWTITLE eq npm"` or find the PID with `netstat -ano | findstr 9847`
- macOS/Linux: `lsof -i :9847` then `kill <PID>`

Then restart: `buhdi-node restart`

### Console window pops up (Windows)

The service wasn't installed with hidden mode. Fix:
```bash
buhdi-node uninstall
buhdi-node install
```

The install command now defaults to hidden mode (no visible window).

### Tools not detected

The node scans for tools on startup. If you install a new tool (like Docker), restart:
```bash
buhdi-node restart
```

---

## Updating

```bash
npm install -g buhdi-node@latest
buhdi-node restart
```

Or if built from source:
```bash
git pull
npm run build
buhdi-node restart
```

---

## Uninstalling

```bash
buhdi-node uninstall
npm uninstall -g buhdi-node
```

Your config and logs remain at `~/.buhdi-node/`. Delete manually if you want a clean removal:
```bash
rm -rf ~/.buhdi-node
```
