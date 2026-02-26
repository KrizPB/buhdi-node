# Buhdi Node Telemetry & Self-Reporting Spec

**Goal:** When a node has problems, the cloud knows automatically and can act on it — no human intervention needed.

**Audience:** Nana-level users. Zero technical knowledge assumed.

---

## Architecture

```
Node crashes → restarts (5-min schtask) → reads crash.log → uploads to cloud
                                                                    ↓
                                                        /api/node/telemetry
                                                                    ↓
                                                    node_telemetry table
                                                                    ↓
                                              ┌─────────────────────┴──────────────────┐
                                              ↓                                        ↓
                                    IT Support Buhdi                          mybuhdi.com dashboard
                                    (auto-triage)                             (user sees status)
                                              ↓
                                    ┌─────────┴─────────┐
                                    ↓                   ↓
                              Auto-patch            Escalate to
                              (push update)         human (Kriz)
```

---

## Phase 1: Crash Reporting (node-side)

### On Startup (in `runConnect`, after `setupDaemon`)

```ts
// If crash.log exists and has entries, upload them
async function reportCrashes(apiKey: string): Promise<void> {
  const crashLog = path.join(os.homedir(), '.buhdi-node', 'crash.log');
  if (!fs.existsSync(crashLog)) return;
  
  const content = fs.readFileSync(crashLog, 'utf8').trim();
  if (!content) return;
  
  // Send last 50 lines max
  const lines = content.split('\n').slice(-50);
  
  await fetch(`${BASE_URL}/api/node/telemetry`, {
    method: 'POST',
    headers: { 'x-node-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'crash_report',
      entries: lines,
      node_version: VERSION,
      os: process.platform,
      arch: process.arch,
      uptime_before_crash: null, // unknown from crash log
      timestamp: new Date().toISOString(),
    }),
  });
  
  // Rotate: move to crash.log.prev, clear current
  const prevPath = crashLog + '.prev';
  fs.copyFileSync(crashLog, prevPath);
  fs.writeFileSync(crashLog, '');
}
```

### Periodic Health Telemetry (every heartbeat, ~30s)

Already sending heartbeats to `/api/node/heartbeat`. Extend payload:

```ts
// In startHeartbeat()
body: JSON.stringify({
  node_id: this.nodeId,
  version: VERSION,
  uptime: Date.now() - this.startedAt,
  connection_state: this._state,
  ws_failure_count: this.wsFailureCount,
  last_task_at: this.lastTaskAt,
  memory_mb: Math.round(process.memoryUsage.rss / 1024 / 1024),
  error_count: this.errorCount, // new: track errors since startup
}),
```

### Connection Loss Reporting

When WS drops and can't recover after N attempts, fire a one-shot telemetry:

```ts
// In onWsFailure(), after threshold
if (this.wsFailureCount === WS_FAILURE_THRESHOLD) {
  this.reportTelemetry('connection_degraded', {
    failure_count: this.wsFailureCount,
    last_connected: this.lastSuccessfulPoll,
  });
}
```

---

## Phase 2: Cloud Endpoints

### `POST /api/node/telemetry`

```sql
CREATE TABLE node_telemetry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID REFERENCES node_registry(id),
  user_id UUID REFERENCES auth.users(id),
  type TEXT NOT NULL, -- 'crash_report' | 'connection_degraded' | 'error' | 'health'
  payload JSONB NOT NULL,
  node_version TEXT,
  severity TEXT DEFAULT 'info', -- 'info' | 'warning' | 'critical'
  resolved BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_telemetry_node ON node_telemetry(node_id, created_at DESC);
CREATE INDEX idx_telemetry_unresolved ON node_telemetry(resolved, severity) WHERE resolved = false;
```

**Severity auto-classification:**
- `crash_report` → `critical`
- `connection_degraded` → `warning`
- `health` → `info`

### `GET /api/node/telemetry?node_id=X&unresolved=true`

Returns telemetry for dashboard display.

### Webhook trigger on critical

When a `critical` telemetry event arrives:
1. Insert into `node_telemetry`
2. Create `bridge_comms` message for IT Support Buhdi
3. If IT Support Buhdi is offline, queue for next heartbeat

---

## Phase 3: IT Support Buhdi Integration

### Auto-Triage Flow

IT Support Buhdi receives telemetry via bridge_comms:

```
FROM: Telemetry System
CLASS: node_issue  
MSG: Node "Kitchen Laptop" (user: Nana) crash report:
     UNCAUGHT: EADDRINUSE 127.0.0.1:9847
     EXIT code=1
     Version: 0.3.0, OS: win32
```

IT Support Buhdi then:

1. **Pattern match** against known issues database (`node_known_issues` table)
2. **If known fix exists:**
   - Check if fix is in a newer version
   - If yes → trigger `SOFTWARE_UPDATE` via WS to that node
   - Log resolution
3. **If unknown:**
   - Create support ticket
   - Escalate to Kriz via email/bridge
   - Tag for engineering review

### Known Issues Database

```sql
CREATE TABLE node_known_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern TEXT NOT NULL,        -- regex or keyword match against crash content
  description TEXT,
  fix_type TEXT,                -- 'update' | 'config_change' | 'manual' | 'self_healing'
  fix_version TEXT,             -- version that contains the fix (for 'update' type)
  fix_instructions JSONB,       -- for config_change: what to change
  auto_resolve BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

Seed with today's bugs:
```sql
INSERT INTO node_known_issues (pattern, description, fix_type, fix_version, auto_resolve) VALUES
('EADDRINUSE', 'Port conflict from zombie process - fixed in 0.3.1', 'update', '0.3.1', true),
('process.exit.*watchdog.*max uptime', 'Watchdog kills daemon, schtasks won''t restart - fixed in 0.3.1', 'update', '0.3.1', true);
```

---

## Phase 4: Software Update Pipeline

Already have the WS handler (`SOFTWARE_UPDATE` message type). Need:

1. **Build pipeline** — GitHub Actions builds `buhdi-node` on tag push, uploads artifact
2. **Version registry** — `/api/node/versions` tracks latest stable + download URL
3. **Update flow:**
   ```
   Cloud sends SOFTWARE_UPDATE via WS
   → Node downloads new dist/ bundle
   → Verifies signature (deploy key)
   → Replaces dist/ files
   → Restarts daemon (process.exit → schtask restarts)
   ```
4. **Rollback** — keep `dist.prev/` backup, revert if new version crashes within 60s

---

## Implementation Priority

| Task | Effort | Impact | Priority |
|------|--------|--------|----------|
| Crash reporting on startup | 2h | High - we learn about failures | **P0** |
| `node_telemetry` table + endpoint | 2h | High - stores the data | **P0** |
| Extended heartbeat payload | 1h | Medium - ongoing health visibility | **P1** |
| IT Support Buhdi webhook trigger | 2h | High - auto-triage | **P1** |
| Known issues DB + pattern matching | 3h | High - auto-resolution | **P1** |
| mybuhdi.com dashboard telemetry UI | 3h | Medium - user visibility | **P2** |
| Software update pipeline | 6h | High - remote patching | **P2** |
| Auto-elevating installer (.msi) | 4h | High - Nana install experience | **P2** |

**Total to "Nana-ready": ~23h of work across P0-P2**

P0 alone (crash reporting + endpoint) = 4h, gets us from "blind" to "we know when nodes break."

---

## Nana Test Scenario

1. Nana gets email: "Click here to set up Buhdi on your computer"
2. Downloads installer, double-clicks → installs, connects, done
3. Computer sleeps/restarts → Buhdi auto-starts within 5 min
4. Something breaks → node uploads crash report → IT Support Buhdi auto-triages
5. Known fix? Push update automatically. Unknown? Alert Kriz.
6. Nana never knows anything went wrong.

That's the goal. Zero-touch reliability.
