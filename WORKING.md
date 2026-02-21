# Buhdi Node - Working Status

## v0.3.0 — Programmable Node

| Phase | Status | Description |
|-------|--------|-------------|
| A | ✅ Complete | Plugin sandbox (isolated-vm, manifest, permissions) |
| B | ✅ Complete | Security hardening (signing, trust levels, vault) |
| C | ✅ Complete | Scheduler, audit logging, resource limits |
| D | ✅ Complete | Dashboard server (HTTP + WS, static assets, cross-plugin data) |

### Phase D Details
- `src/dashboard.ts` — HTTP server on port 3847 (configurable via `dashboardPort`)
- Dashboard plugin type (`"type": "dashboard"`) with `assets/` directory for static files
- Root `/` shows index page listing all dashboard plugins
- `/<plugin-name>/` routes to plugin's static assets
- WebSocket on `/ws` for live event streaming
- Cross-plugin data API: `buhdi.dashboard.setData()`, `getData()`, `emit()`
- Auth: localhost requests pass through; non-local requires Bearer token
- Token auto-generated via `crypto.randomBytes`, stored in config as `dashboardToken`
- Token exposed in health endpoint (localhost only)
- Path traversal protection on static file serving
