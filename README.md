# 🐻 Buhdi Node

**Connect your computer to your AI.**

Buhdi Node turns your machine into a local extension of your [mybuhdi.com](https://mybuhdi.com) AI. It runs tasks, detects tools, manages credentials, and provides a local dashboard — all while syncing with the cloud.

## Install

```bash
npm install -g buhdi-node
buhdi-node setup <YOUR_API_KEY>
buhdi-node install
```

That's it. Opens a dashboard at **http://localhost:9847/**.

## What It Does

- **🔧 Tool Detection** — Finds git, npm, Docker, Python, etc. on your machine and makes them available to your AI
- **⚡ Task Execution** — Your AI runs commands locally through the node (builds, deploys, file operations)
- **🔐 Credential Vault** — Store API keys encrypted on your device. Optional: E2E encrypted cloud sync for portability
- **📊 Dashboard** — Local web UI for chat, monitoring, tool management, and configuration
- **🔄 Auto-Recovery** — Reconnects automatically, restarts on crash, survives reboots

## Dashboard

Once running, visit **http://localhost:9847/**:

| Tab | What it shows |
|-----|--------------|
| 💬 Chat | Talk directly to your AI |
| 📊 Dashboard | Connection, tasks, system info |
| 🔧 Tools | 64+ tools across 11 categories |
| 📋 Jobs | Running and completed tasks |
| 📖 Config | Edit your AI's personality files |
| ⚙️ Settings | Node and connection settings |

## Docs

See [docs/INSTALL.md](docs/INSTALL.md) for full installation guide, troubleshooting, and commands.

## Architecture

```
Your Computer                          Cloud
┌─────────────┐                  ┌──────────────┐
│ Buhdi Node  │ ◄── WebSocket ──► │ mybuhdi.com  │
│             │                  │              │
│ Dashboard   │                  │ AI Engine    │
│ Tool Exec   │                  │ Memory Store │
│ Credential  │                  │ Chat Sync    │
│ Vault       │                  │              │
└─────────────┘                  └──────────────┘
```

## License

Proprietary — !pynq LLC
