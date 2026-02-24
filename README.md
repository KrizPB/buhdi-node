# 🐻 Buhdi Node

**Your AI, your machine, your data. Cloud optional.**

Buhdi Node is a local AI assistant that runs on your hardware. It connects to your local LLM (Ollama), manages credentials securely, executes tools, remembers everything, and works while you sleep — with optional cloud sync via [mybuhdi.com](https://mybuhdi.com).

## Features

| Feature | Description |
|---------|-------------|
| 🤖 **Local AI Engine** | Auto-detects Ollama, routes between local and cloud LLMs |
| 🧠 **Local Memory** | SQLite + vector embeddings, same API as mybuhdi.com |
| 🔧 **Tool Plugins** | Gmail, Stripe, Google Calendar, and more |
| 🔐 **Credential Vault** | AES-256-GCM encrypted, machine-bound keys |
| ⏰ **Scheduler** | Cron-based automation — agents, tools, webhooks, scripts |
| 🤝 **Agent Loop** | ReAct pattern — Plan → Act → Observe → Reflect |
| 📊 **Dashboard** | Dark amber web UI at localhost:9847 |
| 🧙 **First-Run Wizard** | Auto-detects your setup and configures everything |
| ☁️ **Cloud Sync** | Optional pairing with mybuhdi.com for mobile + multi-device |

## Quick Start

```bash
# Install
npm install -g @pynq/buhdi-node

# First run (auto-detects Ollama, opens wizard)
buhdi-node daemon

# Open dashboard
open http://localhost:9847
```

### With Ollama (Recommended)

```bash
# Install Ollama: https://ollama.com
ollama pull llama3.1:8b          # Chat model
ollama pull nomic-embed-text     # Embedding model (for memory search)

# Start Buhdi Node
buhdi-node daemon
```

### With Cloud Pairing

```bash
# Get an API key from mybuhdi.com
buhdi-node connect <YOUR_API_KEY>
```

## Dashboard

Access at `http://localhost:9847` after starting the node.

| Tab | Purpose |
|-----|---------|
| **Chat** | Talk to your local AI with tool execution |
| **Dashboard** | System status, activity feed, AI engine health |
| **Jobs** | Scheduled tasks + running/completed jobs |
| **Tools** | 64-tool catalog with credential management |
| **Memory** | Entity browser, semantic search, stats |
| **Config** | Edit configuration files |
| **Settings** | Node settings and preferences |

## Architecture

```
┌─────────────────────────────────────────┐
│              Buhdi Node                 │
│                                         │
│  ┌──────────┐  ┌───────────┐            │
│  │ LLM      │  │ Tool      │            │
│  │ Router   │  │ Plugins   │            │
│  │          │  │           │            │
│  │ Ollama ←→│  │ Gmail     │            │
│  │ OpenAI   │  │ Stripe    │            │
│  │ Claude   │  │ Calendar  │            │
│  └────┬─────┘  └─────┬─────┘            │
│       │               │                 │
│  ┌────▼───────────────▼─────┐           │
│  │     Agent Loop (ReAct)    │           │
│  │  Plan → Act → Observe → …│           │
│  └────┬──────────────────────┘           │
│       │                                  │
│  ┌────▼─────┐  ┌──────────┐  ┌────────┐│
│  │ SQLite   │  │ Scheduler│  │ Vault  ││
│  │ Memory   │  │ (Cron)   │  │AES-256 ││
│  │ +Vectors │  │          │  │        ││
│  └──────────┘  └──────────┘  └────────┘│
│                                         │
│  ┌──────────────────────────────────────┤
│  │  Dashboard (localhost:9847)          │
│  │  First-Run Wizard                    │
│  └──────────────────────────────────────┤
└────────────┬────────────────────────────┘
             │ (optional)
             ▼
     mybuhdi.com (cloud sync)
```

## Configuration

Config lives at `~/.buhdi-node/config.json`:

```json
{
  "version": 2,
  "healthPort": 9847,
  "llm": {
    "strategy": "local_first",
    "providers": [{
      "name": "ollama",
      "type": "ollama",
      "endpoint": "http://localhost:11434",
      "model": "llama3.1:8b",
      "priority": 1,
      "enabled": true
    }]
  },
  "memory": {
    "enabled": true,
    "embedding_model": "nomic-embed-text"
  },
  "scheduler": {
    "allowScripts": false
  }
}
```

## Security

- **Credential Vault**: AES-256-GCM encryption with machine-derived keys (PBKDF2)
- **Dashboard Auth**: Bearer token required for all API endpoints
- **Tool Safety Tiers**: READ (auto), WRITE (configurable), DELETE (confirm), FINANCIAL (confirm+PIN)
- **LLM Safety**: Tool call validation, output sanitization, prompt injection guards
- **Script Execution**: Disabled by default, requires explicit `allowScripts: true`
- **SSRF Protection**: Webhook URLs blocked from private/internal networks

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check |
| `/api/status` | GET | Node status |
| `/api/wizard/status` | GET | First-run wizard detection |
| `/api/wizard/auto-config` | POST | Auto-configure node |
| `/api/memory/status` | GET | Memory stats |
| `/api/memory/entities` | GET/POST | Entity CRUD |
| `/api/memory/search` | GET | Semantic search |
| `/api/memory/context` | GET | Context search (for AI) |
| `/api/llm/status` | GET | LLM provider health |
| `/api/llm/chat` | POST | Chat with tool execution |
| `/api/schedules` | GET/POST | Schedule CRUD |
| `/api/credentials` | GET/POST/DELETE | Credential vault |
| `/api/agent/run` | POST | Run agent goal |

## Running as a Service

### Windows (Scheduled Task)
```bash
buhdi-node install    # Creates hidden scheduled task
buhdi-node uninstall  # Removes it
```

### macOS/Linux
```bash
buhdi-node daemon     # Run in background
# Or use systemd/launchd — see docs/INSTALL.md
```

## Development

```bash
git clone https://github.com/KrizPB/buhdi-node.git
cd buhdi-node
npm install
npx tsc              # Compile TypeScript
node dist/index.js daemon
```

## License

MIT — © 2026 !pynq LLC
