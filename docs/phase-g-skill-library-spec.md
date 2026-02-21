# Phase G: Skill Library & Marketplace Spec

**Version:** 1.0
**Author:** Buhdi
**Date:** 2026-02-20
**Status:** Draft
**Depends on:** Phases A-F complete

---

## 1. Vision

Cloud Buhdi maintains a shared skill library. When a user needs a capability, Cloud Buhdi checks the library first. If the skill exists, it deploys it. If not, it builds one from scratch, Ward audits it, and optionally contributes it back to the library. Every user's Buhdi makes every other user's Buhdi smarter.

This is the moat: after 6 months of users, the skill library contains hundreds of battle-tested, Ward-audited tools that no competitor can replicate.

---

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│              mybuhdi.com (Cloud)             │
│                                             │
│  ┌─────────────┐    ┌──────────────────┐    │
│  │ Skill       │    │ Cloud Buhdi      │    │
│  │ Library DB  │◄──►│ (Agent)          │    │
│  │             │    │                  │    │
│  │ - system    │    │ 1. Check library │    │
│  │ - community │    │ 2. Build if miss │    │
│  │ - auto-gen  │    │ 3. Ward audit    │    │
│  └─────────────┘    │ 4. Deploy        │    │
│         ▲           │ 5. Contribute    │    │
│         │           └──────────────────┘    │
│         │                    │               │
│  ┌──────┴──────┐            │               │
│  │ Marketplace │            │               │
│  │ Browse/Search│           │               │
│  │ Install     │            │               │
│  └─────────────┘            │               │
└─────────────────────────────┼───────────────┘
                              │ Deploy Pipeline
                              │ (Phase E)
                    ┌─────────▼─────────┐
                    │   buhdi-node(s)   │
                    │   Plugin Runtime  │
                    │   (Phase A)       │
                    └───────────────────┘
```

---

## 3. Database Schema

### 3.1 `skill_library` table

```sql
CREATE TABLE IF NOT EXISTS skill_library (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  
  -- Identity
  name text NOT NULL UNIQUE,
  display_name text NOT NULL,
  version text NOT NULL,
  description text,
  category text NOT NULL,           -- see categories below
  tags text[] DEFAULT '{}',
  
  -- Content
  manifest jsonb NOT NULL,          -- full PluginManifest
  code text NOT NULL,               -- plugin source code
  code_hash text NOT NULL,          -- sha256 for integrity
  
  -- Authorship
  author_type text NOT NULL DEFAULT 'system',  -- system | community | auto-generated
  author_user_id uuid REFERENCES auth.users(id),  -- null for system/auto
  author_display text,              -- "mybuhdi.com" for system, anonymized for auto
  
  -- Quality
  quality_grade text,               -- A, B, C from Ward audit
  ward_findings jsonb DEFAULT '[]', -- audit results
  ward_audited_at timestamptz,
  
  -- Usage
  install_count integer DEFAULT 0,
  active_installs integer DEFAULT 0,
  avg_error_rate numeric(5,4) DEFAULT 0,
  avg_health_score numeric(5,4) DEFAULT 1.0,
  
  -- Lifecycle
  status text NOT NULL DEFAULT 'draft',  -- draft | review | published | deprecated | removed
  published_at timestamptz,
  deprecated_at timestamptz,
  deprecation_reason text,
  
  -- Metadata
  min_node_version text DEFAULT '0.3.0',
  required_permissions jsonb DEFAULT '{}',
  readme text,                      -- markdown documentation
  changelog text,                   -- version history
  
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- RLS
ALTER TABLE skill_library ENABLE ROW LEVEL SECURITY;

-- Anyone can browse published skills
CREATE POLICY "Published skills are public" 
  ON skill_library FOR SELECT 
  USING (status = 'published');

-- Authors can see their own drafts
CREATE POLICY "Authors see own skills" 
  ON skill_library FOR SELECT 
  USING (auth.uid() = author_user_id);

-- Only system can insert (via service role)
-- Community contributions go through review pipeline

-- Indexes
CREATE INDEX idx_sl_category ON skill_library(category);
CREATE INDEX idx_sl_status ON skill_library(status);
CREATE INDEX idx_sl_name ON skill_library(name);
CREATE INDEX idx_sl_tags ON skill_library USING GIN(tags);
CREATE INDEX idx_sl_installs ON skill_library(install_count DESC);
```

### 3.2 `skill_installs` table (tracking)

```sql
CREATE TABLE IF NOT EXISTS skill_installs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) NOT NULL,
  skill_id uuid REFERENCES skill_library(id) NOT NULL,
  node_id text NOT NULL,
  installed_version text NOT NULL,
  status text NOT NULL DEFAULT 'active',  -- active | uninstalled | error
  installed_at timestamptz DEFAULT now(),
  uninstalled_at timestamptz,
  UNIQUE(user_id, skill_id, node_id)
);

ALTER TABLE skill_installs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own installs" ON skill_installs FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users manage own installs" ON skill_installs FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own installs" ON skill_installs FOR UPDATE USING (auth.uid() = user_id);
```

### 3.3 Categories

| Category | Description | Example Skills |
|----------|-------------|----------------|
| `data` | Data processing, CSV, analysis | csv-parser, data-aggregator |
| `web` | Web scraping, API integration | web-scraper, api-monitor |
| `files` | File management, conversion | pdf-converter, image-resizer |
| `monitoring` | System & service monitoring | uptime-checker, disk-monitor |
| `automation` | Task automation, scheduling | backup-runner, log-rotator |
| `integration` | Third-party service connectors | slack-notifier, square-pos-sync |
| `dashboard` | Custom UI dashboards | sales-dashboard, server-stats |
| `security` | Security scanning, hardening | port-scanner, cert-checker |
| `ai` | AI/ML related tools | text-classifier, sentiment-analyzer |
| `utility` | General purpose utilities | hash-generator, env-checker |

---

## 4. API Endpoints

### 4.1 Browse & Search

**`GET /api/skills`**
- Public (no auth required for published)
- Query: `?category=X&q=search&sort=popular|recent|grade&limit=20&offset=0`
- Returns: paginated skill list (no code, just metadata)

**`GET /api/skills/[id]`**
- Public for published skills
- Returns: full skill details including readme, permissions, changelog
- Does NOT return raw code (security)

### 4.2 Install

**`POST /api/skills/[id]/install`**
- Auth required
- Body: `{ nodeId: string, nodeIds?: string[] }`
- Flow:
  1. Verify user owns node(s)
  2. Fetch skill manifest + code
  3. Sign code via deploy pipeline (Phase E)
  4. Dispatch to node(s) as INSTALL_PLUGIN task
  5. Record in `skill_installs`
  6. Increment `install_count`

**`DELETE /api/skills/[id]/install`**
- Auth required
- Body: `{ nodeId: string }`
- Uninstalls from node, updates tracking

### 4.3 Auto-Contribute (Internal Only)

**`POST /api/skills/auto-contribute`**
- Internal (service role only)
- Called by Cloud Buhdi after building a new tool that passes Ward
- Body: `{ name, manifest, code, originalTaskContext }`
- Auto-anonymizes, sets author_type='auto-generated'
- Status='review' (human approval before publishing)

### 4.4 Admin/Review

**`GET /api/skills/review`**
- Admin only
- Returns skills in 'review' status
- Used by Kriz to approve community/auto contributions

**`POST /api/skills/[id]/approve`**
- Admin only
- Sets status='published', published_at=now()

**`POST /api/skills/[id]/reject`**
- Admin only
- Body: `{ reason: string }`
- Sets status='removed' with reason

### 4.5 Fleet Sync

**`POST /api/skills/[id]/deploy-all`**
- Auth required
- Deploys skill to ALL of user's active nodes
- Uses fleet query infrastructure from Phase F

---

## 5. Cloud Buhdi Integration

### 5.1 Skill Resolution Flow

When Cloud Buhdi receives a task that requires a node capability:

```
1. Parse task → identify required capability
2. GET /api/skills?q=<capability>&category=<best_guess>
3. If match found with grade A/B:
   a. POST /api/skills/{id}/install → deploy to user's node
   b. Execute task using installed skill
4. If no match:
   a. Build custom tool (existing Phase A flow)
   b. Ward audit (Phase E)
   c. Deploy to node
   d. If successful + user opted in:
      POST /api/skills/auto-contribute
5. Log resolution path for analytics
```

### 5.2 Skill Suggestion

Cloud Buhdi can proactively suggest skills:
- During onboarding: "Based on your business type, these skills might help..."
- After errors: "This skill from the library handles that use case better"
- On diagnosis (Phase F): "A community skill solves this pattern"

---

## 6. Seed Skills (Preloaded)

Adapted from OpenClaw skills and common use cases:

| Skill | Category | Source |
|-------|----------|--------|
| `uptime-checker` | monitoring | New — HTTP endpoint monitoring with alerts |
| `disk-monitor` | monitoring | New — Disk space alerts |
| `backup-runner` | automation | New — Scheduled file/dir backup |
| `log-rotator` | automation | New — Log file rotation and cleanup |
| `csv-analyzer` | data | New — CSV parsing and basic analysis |
| `web-scraper` | web | New — Configurable web page scraper |
| `api-health` | monitoring | New — REST API health checker |
| `port-scanner` | security | New — Local network port scanning |
| `cert-checker` | security | New — SSL certificate expiry monitoring |
| `system-stats` | dashboard | New — CPU/mem/disk dashboard plugin |

These ship as `author_type='system'`, pre-audited, grade A.

---

## 7. ToS / Legal Requirements

### 7.1 Skill Ownership Disclosure

**Must be in Terms of Service:**

> **7.x Auto-Generated Tools and Skills**
> 
> When the Service's AI agent ("Cloud Buhdi") creates tools, plugins, or skills 
> on your behalf, ownership is determined as follows:
> 
> (a) **Auto-Generated Skills:** Tools created by Cloud Buhdi through its 
> autonomous tool-building capabilities are the intellectual property of 
> mybuhdi.com ("Company"). These tools may be anonymized and made available 
> to other users through the Skill Library.
> 
> (b) **User-Uploaded Skills:** Custom code, tools, or plugins that you 
> personally write and upload remain your intellectual property. You grant 
> mybuhdi.com a limited license to host, run, and audit these tools as 
> necessary to provide the Service.
> 
> (c) **Shared Library License:** Skills published to the Skill Library 
> are licensed to all mybuhdi.com users under a non-exclusive, royalty-free 
> license for use within the Service. Skills may not be extracted, 
> redistributed, or used outside the Service without written permission.
> 
> (d) **Opt-Out:** You may opt out of contributing auto-generated skills 
> to the Skill Library in your account settings. Opting out does not affect 
> your ability to use skills from the Library.
> 
> (e) **No User Data in Skills:** Auto-generated skills are automatically 
> sanitized to remove any user-specific data, credentials, or personally 
> identifiable information before contribution to the Library. This process 
> is enforced by automated security audit.

### 7.2 In-Product Consent

- First-time skill contribution → modal explaining the policy
- Account settings toggle: "Contribute auto-generated skills to Library" (default: ON)
- Each contribution shows a preview of what will be shared (anonymized code)
- Clear "What's shared / What's NOT shared" breakdown

### 7.3 Privacy Safeguards (Ward Enforced)

Before any skill enters the library:
1. Ward scans for hardcoded credentials, API keys, tokens
2. Ward scans for PII patterns (emails, phone numbers, addresses)
3. Ward scans for user-specific URLs, IPs, hostnames
4. Code comments are stripped
5. Config values are replaced with placeholders
6. If ANY user data detected → contribution blocked

---

## 8. Dashboard UI

### 8.1 Skill Library Page (`/dashboard/skills`)

- Search bar with category filters
- Grid of skill cards: name, description, category badge, grade badge, install count
- Click → detail page with readme, permissions, install button
- "Installed" tab showing user's active skills across nodes

### 8.2 Skill Detail Page

- Full readme/documentation
- Permissions required
- Install button (select which node(s))
- "Installed on X nodes" indicator

---

## 9. Estimated Timeline

| Component | Effort |
|-----------|--------|
| Database schema + migration | 1 day |
| Browse/Search/Install APIs | 2 days |
| Contribute + auto-contribute flow | 2 days |
| Ward data sanitization rules | 1 day |
| Cloud Buhdi skill resolution | 2 days |
| Seed skills (10 preloaded) | 3 days |
| Dashboard UI (browse + install) | 2 days |
| ToS update + consent flow | 1 day |
| Fleet sync | 1 day |
| Testing + polish | 2 days |
| **Total** | **~2-3 weeks** |

---

## 10. Success Metrics

- Library size: 10 seed → 50 skills in 3 months → 200 in 6 months
- Install rate: >60% of users install at least 1 library skill
- Build-vs-library ratio: Cloud Buhdi finds existing skill >40% of the time
- Contribution rate: >20% of auto-generated tools pass Ward + contribute
- Error rate: Library skills have <5% error rate (vs custom-built)

---

## 11. Design Decisions (Locked)

1. **Skill versioning: Auto-update.** Cloud Buhdi owns the library AND controls the nodes. Library updates → Cloud Buhdi checks which nodes have that skill → pushes new version through deploy pipeline (Ward audited). No user action needed.

2. **No rating system.** Internal library, not a public marketplace. Users see skills as "here's what your AI can do" — not a catalog to browse and review.

3. **All free.** Moat grows faster when every user benefits. Premium skills would slow adoption.

4. **No forking/custom user skills.** Keeps the library clean, prevents malicious code injection. Only Cloud Buhdi (with Ward audit) and system-authored skills enter the library. Users request capabilities, Cloud Buhdi builds them.

5. **Skill synergy via graph memory (not hard dependencies).** Cloud Buhdi learns which skills work well together through execution patterns. Stored as relationship edges in the graph: "skill A + skill B → better outcome for task type X". Examples:
   - Ralph Loop + UI QA = better deploys
   - Web scraper + CSV analyzer = market research pipeline
   - Disk monitor + backup runner = proactive data protection
   
   Over time, Cloud Buhdi recommends and chains skills automatically. No hardcoded dependencies — emergent intelligence from usage patterns.

### 11.1 Skill Synergy Schema

```sql
CREATE TABLE IF NOT EXISTS skill_synergies (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  skill_a text NOT NULL REFERENCES skill_library(name),
  skill_b text NOT NULL REFERENCES skill_library(name),
  task_category text NOT NULL,           -- what type of task benefits
  effectiveness_score numeric(5,4),       -- 0-1, learned from outcomes
  observation_count integer DEFAULT 1,    -- how many times seen together
  discovered_at timestamptz DEFAULT now(),
  last_observed_at timestamptz DEFAULT now(),
  UNIQUE(skill_a, skill_b, task_category)
);
```

Cloud Buhdi queries this before building new tools: "For task X, skills A+B together have a 0.92 effectiveness score across 47 observations → recommend chaining them."
