# Node Topology & Capability-Aware Routing Spec

**Goal:** Multiple Buhdi Nodes working together under one user account, with intelligent task routing based on each node's role and capabilities.

---

## Topologies

### 1. Node-Primary (Power User / Privacy-First)
```
Mac Mini (brain)                    Kitchen Laptop (hands)
  - Local LLM (128GB)                - File access, screenshots
  - Memory DB (primary)               - Tool execution
  - Makes decisions                    - Reports results back
         ↕                                    ↕
              mybuhdi.com (router + backup)
```
- Brain node runs the AI, makes decisions, holds primary memory
- Hands nodes execute tasks (shell commands, file ops, screenshots, tool calls)
- Cloud stores memory backup + routes tasks between nodes
- If brain goes offline, cloud can take over temporarily

### 2. Cloud-Primary (Most Users / Nana)
```
mybuhdi.com (brain)
       ↕
  Kitchen Laptop (hands)
  - Executes tasks cloud assigns
  - Reports capabilities
  - Syncs memory slices
```
- Cloud Buhdi is the AI brain
- Nodes are execution endpoints
- Simplest setup, works today

### 3. Hybrid (Business / Multi-Location)
```
Office Mac Mini (brain + hands)     Warehouse Pi (hands)     Employee Laptop (hands)
  - Local LLM for sensitive data      - Inventory scanner      - CRM access
  - Also runs local tools             - Camera feeds           - Email tools
         ↕                                  ↕                       ↕
                        mybuhdi.com (router + shared memory)
```
- One powerful node is brain + hands
- Other nodes are specialized hands
- Cloud coordinates everything

---

## Architecture

### Node Registration (exists today)
Each node already reports on connect:
```json
{
  "nodeId": "aa8f8591-...",
  "nodeName": "Kitchen Laptop",
  "system": { "os": "win32", "arch": "x64", "memory": 8192 },
  "software": { "ollama": true, "docker": false, "python": true },
  "tools": ["gmail", "stripe_payments", "shell", "file_read"]
}
```

### New: Node Role Config
Add to node config:
```json
{
  "role": "brain" | "hands" | "hybrid",
  "capabilities": {
    "llm": true,           // Can run AI inference
    "vision": true,         // Has vision model
    "gpu": true,            // Has GPU/Apple Silicon
    "fileAccess": true,     // Can read/write local files
    "shell": true,          // Can execute commands
    "tools": ["gmail", "stripe_payments"]
  },
  "memoryMode": "primary" | "replica" | "slice",
  "acceptTaskTypes": ["*"] | ["shell", "file", "tool"]  // What tasks this node handles
}
```

### New: Cloud-Side Node Registry Enhancement

```sql
-- Extend existing node_registry table
ALTER TABLE node_registry ADD COLUMN role TEXT DEFAULT 'hands';
ALTER TABLE node_registry ADD COLUMN capabilities JSONB DEFAULT '{}';
ALTER TABLE node_registry ADD COLUMN accept_task_types TEXT[] DEFAULT '{*}';
ALTER TABLE node_registry ADD COLUMN last_capability_report TIMESTAMPTZ;
```

### New: Task Routing Engine (Cloud-Side)

When Cloud Buhdi (or brain node via cloud relay) needs a task executed:

```
1. Classify task → what capability is needed?
   - "Take a screenshot" → needs: shell + display
   - "Read file X" → needs: fileAccess
   - "Run Stripe refund" → needs: tool:stripe_payments
   - "Analyze this image" → needs: vision + llm
   
2. Find capable node(s)
   - Query node_registry WHERE status='online' AND capabilities match
   - Prefer: hands nodes for execution, brain nodes for thinking
   
3. Route task
   - Send via existing WS task dispatch
   - If no capable node online → queue for retry OR fall back to cloud
   
4. Collect result
   - Node executes, returns result via WS
   - Cloud relays to requester (brain node or chat user)
```

### Routing Logic (Pseudocode)

```typescript
async function routeTask(userId: string, task: Task): Promise<string> {
  const nodes = await getOnlineNodes(userId);
  
  // Determine required capabilities
  const required = classifyTaskRequirements(task);
  // e.g. { shell: true, tool: 'stripe_payments' }
  
  // Filter capable nodes
  const capable = nodes.filter(n => meetsRequirements(n.capabilities, required));
  
  if (capable.length === 0) {
    // No node can do it — try cloud fallback
    if (canCloudHandle(required)) {
      return executeInCloud(task);
    }
    throw new Error(`No online node has required capabilities: ${JSON.stringify(required)}`);
  }
  
  // Prefer hands nodes for execution tasks, brain for thinking
  const sorted = capable.sort((a, b) => {
    if (task.type === 'inference') {
      // Prefer brain nodes for AI tasks
      return (b.role === 'brain' ? 1 : 0) - (a.role === 'brain' ? 1 : 0);
    }
    // Prefer hands nodes for execution tasks
    return (b.role === 'hands' ? 1 : 0) - (a.role === 'hands' ? 1 : 0);
  });
  
  // Dispatch to best candidate
  return dispatchToNode(sorted[0].nodeId, task);
}
```

### Node-to-Node Communication (via Cloud Relay)

Nodes don't talk directly. Cloud relays:

```
Brain Node: "I need someone to run `git pull` on the Kitchen Laptop"
    ↓ WS message to cloud
Cloud Router: finds Kitchen Laptop is online, has shell capability
    ↓ WS task dispatch to Kitchen Laptop
Kitchen Laptop: executes, returns result
    ↓ WS result to cloud  
Cloud Router: relays result back to Brain Node
    ↓ WS message to brain
Brain Node: gets the result, continues thinking
```

New WS message types:
```typescript
// Brain → Cloud: "I need a task done on another node"
{ type: 'task_request', targetNode?: string, targetCapability?: string, task: {...} }

// Cloud → Node: "Execute this task" (already exists)
{ type: 'task', id: string, action: string, params: {...} }

// Node → Cloud: "Task complete" (already exists)  
{ type: 'task_result', taskId: string, result: {...} }

// Cloud → Brain: "Here's the result from another node"
{ type: 'task_response', requestId: string, sourceNode: string, result: {...} }
```

### Memory Modes

| Mode | Description | Use case |
|------|-------------|----------|
| **primary** | Full memory DB, syncs UP to cloud | Brain node (Mac Mini) |
| **replica** | Full copy, syncs DOWN from cloud | Backup node |
| **slice** | Only relevant subset (e.g. tools config, current task context) | Hands-only nodes (Nana's laptop) |

Slice mode saves bandwidth and storage — Nana's laptop doesn't need Kriz's full entity graph, just enough context to execute tasks.

---

## Implementation Priority

| Task | Effort | What it enables |
|------|--------|-----------------|
| Node role config (`role` field) | 1h | Nodes declare their role |
| Capability reporting on connect | 2h | Cloud knows what each node can do |
| Cloud routing engine | 4h | Smart task dispatch to right node |
| `task_request` WS message (brain→cloud→hands) | 3h | Brain can delegate to hands |
| `task_response` relay (hands→cloud→brain) | 2h | Results flow back |
| Memory slice mode | 4h | Lightweight nodes |
| Dashboard: multi-node view | 3h | See all your nodes + status |
| Fallback logic (node offline → cloud or queue) | 2h | Resilience |

**Total: ~21h**

### Phase 1: Basic Routing (8h) — enables topology 1 & 2
- Node role config
- Capability reporting  
- Cloud routing engine
- Task dispatch to capable node

### Phase 2: Brain-Hands Relay (5h) — enables power user flow
- `task_request` / `task_response` messages
- Brain node can orchestrate hands nodes

### Phase 3: Memory Slicing + Polish (8h) — enables topology 3
- Memory slice mode for lightweight nodes
- Multi-node dashboard
- Fallback/queuing logic

---

## Kriz's Setup (Day 1 with Mac Mini)

```
Mac Mini 128GB (brain + hybrid)
  role: "brain"
  capabilities: { llm: true, vision: true, gpu: true, shell: true, fileAccess: true }
  memoryMode: "primary"
  Local models: llama3.1:70b, llava, codestral
  
Kitchen Laptop (hands)
  role: "hands"  
  capabilities: { shell: true, fileAccess: true, tools: ["gmail"] }
  memoryMode: "slice"
  No local LLM (too weak)

mybuhdi.com (cloud router + backup)
  Stores memory backup
  Routes tasks between nodes
  Handles web chat users
  Falls back to cloud AI if Mac Mini offline
```

Mac Mini thinks. Kitchen Laptop does. Cloud coordinates.
That's the play.
