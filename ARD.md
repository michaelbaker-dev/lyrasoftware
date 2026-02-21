# Lyra Control — Architecture Decision Record

## ADR-001: Web Framework — Next.js 15 App Router

**Status**: Accepted

**Decision**: Next.js 15 with App Router, Server Components, Server Actions

**Rationale**:
- Consistent with OpenClaw ecosystem (mission-control is Next.js)
- Server Components for real-time dashboard rendering
- Server Actions for onboarding steps (form submission → server-side execution)
- API Routes for webhooks and dispatcher control endpoints
- App Router provides file-based routing with layouts and loading states

**Consequences**:
- Requires Node.js 18+
- Server Components limit client-side interactivity (use `"use client"` where needed)
- Server Actions simplify form handling but require careful error handling

---

## ADR-002: Database — SQLite + DuckDB

**Status**: Accepted

**Decision**: SQLite (via Prisma) for relational data, DuckDB for analytics

**Rationale**:
- Zero infrastructure — no database server needed on Mac mini
- SQLite handles projects, agents, sessions, audit logs (ACID, relational)
- DuckDB handles DORA metrics, cost tracking, time-series aggregations (10-100x faster than SQLite for analytical queries)
- DuckDB can query SQLite directly via `sqlitescanner` extension — no ETL pipeline needed
- Single-user local app doesn't need PostgreSQL's concurrency features
- Both databases are embedded — just files on disk

**Migration Path**: If multi-user or cloud deployment is needed later, Prisma supports PostgreSQL with minimal schema changes.

**Consequences**:
- SQLite has limited concurrent write support (WAL mode helps)
- DuckDB adds a dependency but provides significant analytics performance
- No need for database server management or connection pooling

---

## ADR-003: Dispatcher — In-Process TypeScript Service

**Status**: Accepted

**Decision**: Dispatcher runs as a TypeScript module within the Next.js process, managed via API routes, not as separate shell scripts.

**Rationale**:
- Integrated logging and error handling with the web app
- SSE streaming of agent output directly to UI (shared process)
- Rate limit tracking with shared state (no IPC needed)
- No separate process management or monitoring required
- Can be started/stopped from the UI via API routes
- Simpler deployment — one process to manage

**Consequences**:
- Dispatcher lifecycle is tied to the Next.js process
- Long-running agent processes are spawned as child processes (not blocked)
- Need graceful shutdown handling to clean up running agents

---

## ADR-004: Agent Execution — Claude Code Headless

**Status**: Accepted

**Decision**: Agents run via `claude -p --dangerously-skip-permissions --output-format stream-json`

**Rationale**:
- Full autonomy without permission prompts (required for unattended operation)
- `stream-json` output enables real-time progress tracking in the UI
- Session resumption via `--resume` flag for interrupted work
- Claude Code provides deep codebase navigation, iterative test-run-fix loops, and tool use that raw LLM API calls cannot match

**Consequences**:
- Requires Claude Max subscription for meaningful throughput
- ~900 messages per 5-hour window shared across all concurrent sessions
- Agents have full system access — trust boundary is at the worktree level
- Need to monitor for runaway processes

---

## ADR-005: OpenRouter/auto for Non-Coding Tasks

**Status**: Accepted

**Decision**: Route all non-coding AI tasks through OpenRouter/auto API

**Rationale**:
- Preserves Claude Max token budget for actual coding (the bottleneck)
- OpenRouter/auto auto-selects the optimal model per prompt
- Cost-efficient for conversational, routing, and classification tasks
- Provides model diversity without managing multiple API keys

**API Usage**:
```typescript
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: "openrouter/auto",
    messages: [{ role: "user", content: prompt }]
  })
});
```

**Consequences**:
- Depends on external API availability
- Model selection is opaque (auto-routing)
- Cost tracking requires OpenRouter usage API

---

## ADR-006: GitHub Integration — gh CLI

**Status**: Accepted

**Decision**: Use `gh` CLI for all GitHub operations

**Rationale**:
- Already authenticated on the Mac mini
- Scriptable: repo creation, branch protection, PR management, CI status
- No need for Octokit or REST API client library
- Consistent with how Claude Code itself interacts with GitHub

**Operations**:
```bash
gh repo create michaelbaker-dev/<name> --private
gh api repos/michaelbaker-dev/<name>/branches/main/protection -X PUT ...
gh pr create --title "..." --body "..."
gh pr merge <number> --auto --squash
```

**Consequences**:
- Requires `gh` CLI installed and authenticated
- Shell execution introduces potential for command injection (mitigated by input validation)
- Error handling requires parsing CLI output

---

## ADR-007: Jira Integration — REST API v3

**Status**: Accepted

**Decision**: Direct Jira REST API v3 calls via `fetch`

**Rationale**:
- Full control over project creation, custom fields, workflow transitions, automation rules
- No SDK dependency to maintain
- REST API is well-documented and stable
- Authentication via Basic Auth (email + API token)

**Base URL**: `https://mbakers.atlassian.net/rest/api/3/`

**Key Endpoints**:
- `POST /issue` — Create tickets
- `PUT /issue/{key}` — Update fields
- `POST /issue/{key}/transitions` — Move through workflow
- `POST /issue/{key}/comment` — Add agent activity logs
- `GET /search?jql=...` — Query for work

**Consequences**:
- Must handle Jira API rate limits (no official limit, but throttling at ~100 req/min)
- Custom field IDs vary per instance — must discover via `GET /field`
- No automatic retry/pagination — must implement

---

## ADR-008: Real-Time Updates — Server-Sent Events (SSE)

**Status**: Accepted

**Decision**: SSE for dashboard real-time updates, not WebSocket

**Rationale**:
- Simpler than WebSocket for one-directional server→client updates
- Native browser support via `EventSource` API — no additional library
- Dashboard needs: agent status changes, new audit log entries, dispatcher activity — all server→client only
- Automatic reconnection built into the browser API
- Works through proxies and load balancers without special configuration

**Implementation**: Next.js API route with `ReadableStream` response, `text/event-stream` content type.

**Consequences**:
- Unidirectional only (server→client) — client actions use regular fetch/Server Actions
- Limited to ~6 concurrent connections per domain in HTTP/1.1 (not an issue for single-user app)
- No binary data support (not needed)

---

## ADR-009: Template Engine — Handlebars

**Status**: Accepted

**Decision**: Handlebars for project scaffolding templates

**Rationale**:
- Simple, logic-less templates for CLAUDE.md, CI workflows, PR templates
- Well-established, minimal API surface
- Templates are readable by non-developers (Product Owner can review)
- No need for a full template engine (EJS, Nunjucks)

**Templates to Generate**:
- `CLAUDE.md` — Project-specific Claude Code instructions
- `ci.yml` — GitHub Actions CI pipeline (lint → test → build)
- `auto-merge.yml` — Auto-merge workflow for approved PRs
- `rollback.yml` — Auto-rollback on post-merge test failure
- `pull_request_template.md` — PR template with Jira linking

**Consequences**:
- Limited logic in templates (intentional — keeps them simple)
- Must compile templates at build time or cache compiled versions

---

## ADR-010: File Structure — Feature-Based

**Status**: Accepted

**Decision**: App router pages organized by feature, not by type

**Rationale**:
- Each page (onboarding, projects, metrics, agents, settings) is self-contained
- Components, server actions, and types colocated with their page
- Reduces cross-directory navigation
- Shared components in a top-level `components/` directory

**Structure**:
```
src/app/
├── layout.tsx              # Root layout with sidebar
├── page.tsx                # Dashboard home
├── onboarding/
│   ├── page.tsx            # Onboarding wizard
│   ├── actions.ts          # Server actions (create repo, create Jira project, etc.)
│   └── components/         # Step components
├── projects/
│   ├── page.tsx            # Project list
│   └── [id]/
│       └── page.tsx        # Project detail
├── metrics/
│   └── page.tsx            # DORA metrics
├── agents/
│   └── page.tsx            # Agent management
└── settings/
    └── page.tsx            # Settings
```

**Consequences**:
- Some duplication of utility code across features (acceptable for clarity)
- Shared types in `src/lib/types.ts`

---

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────┐
│                    LYRA CONTROL                          │
│                  (Next.js 15 App)                        │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │Onboarding│  │Dashboard │  │ Metrics  │  │Settings │ │
│  │ Wizard   │  │  Home    │  │  (DORA)  │  │         │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│       │              │              │              │      │
│  ┌────▼──────────────▼──────────────▼──────────────▼────┐│
│  │              Server Actions / API Routes              ││
│  └──┬──────┬──────┬──────┬──────┬──────┬────────────────┘│
│     │      │      │      │      │      │                  │
│  ┌──▼──┐┌──▼──┐┌──▼──┐┌──▼───┐┌─▼──┐┌─▼───┐            │
│  │Jira ││GitHub││Open ││Disp- ││QA  ││SSE  │            │
│  │Clie-││Clie-││Route││atch- ││Run-││Strea│            │
│  │nt   ││nt   ││r    ││er    ││ner ││m    │            │
│  └──┬──┘└──┬──┘└──┬──┘└──┬───┘└─┬──┘└─────┘            │
│     │      │      │      │      │                        │
└─────┼──────┼──────┼──────┼──────┼────────────────────────┘
      │      │      │      │      │
      ▼      ▼      ▼      ▼      ▼
   Jira   GitHub  Open   Claude  Claude
   API    gh CLI  Router  Code    Code
                  /auto   (dev)   (QA)

Storage:
┌──────────┐     ┌──────────┐
│  SQLite  │────▶│  DuckDB  │
│ (Prisma) │     │(analytics)│
│          │     │          │
│Projects  │     │DORA agg  │
│Agents    │     │Cost agg  │
│Sessions  │     │Time-series│
│AuditLogs │     │queries   │
└──────────┘     └──────────┘
```

## Data Flow

```
User Message → Lyra (OpenClaw) → Jira Ticket
                                      │
                                      ▼
            Dispatcher (polls every 15 min)
                      │
                      ▼
              Create Worktree
              Spawn Claude Code
              (--dangerously-skip-permissions)
                      │
                      ▼
              Agent Implements Feature
              Writes Tests, Commits
                      │
                      ▼
              Push Branch → Create PR
                      │
                      ▼
              GitHub Actions CI
              (lint → test → build)
                      │
              ┌───────┴───────┐
              ▼               ▼
          CI Pass         CI Fail
              │               │
              ▼               ▼
        Auto-Merge      Agent Fixes
        to develop       & Retries
              │
              ▼
        Post-Merge Smoke Test
              │
        ┌─────┴─────┐
        ▼           ▼
     Pass        Fail
        │           │
        ▼           ▼
    QA Agent    Auto-Revert
    Tests       Create Bug
        │
   ┌────┴────┐
   ▼         ▼
Pass      Fail
   │         │
   ▼         ▼
 Done     Bug Ticket
           → Dev Agent
```

## Prisma Schema (Key Models)

```prisma
model Project {
  id            String   @id @default(cuid())
  name          String
  path          String
  jiraKey       String   @unique
  githubRepo    String
  techStack     String
  status        String   @default("active")
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  agents        Agent[]
  sessions      Session[]
  auditLogs     AuditLog[]
}

model Agent {
  id            String   @id @default(cuid())
  name          String
  role          String   // architect, dev, qa
  model         String   // claude-opus-4, claude-sonnet-4-5, etc.
  status        String   @default("idle") // idle, running, errored, rate-limited
  projectId     String?
  project       Project? @relation(fields: [projectId], references: [id])
  currentTicket String?
  startedAt     DateTime?
  sessions      Session[]
}

model Session {
  id            String   @id @default(cuid())
  agentId       String
  agent         Agent    @relation(fields: [agentId], references: [id])
  projectId     String
  project       Project  @relation(fields: [projectId], references: [id])
  ticketKey     String
  branch        String
  worktreePath  String
  status        String   @default("running") // running, completed, failed, cancelled
  tokensUsed    Int      @default(0)
  cost          Float    @default(0)
  startedAt     DateTime @default(now())
  completedAt   DateTime?
  output        String?  // JSON log
}

model AuditLog {
  id            String   @id @default(cuid())
  projectId     String?
  project       Project? @relation(fields: [projectId], references: [id])
  action        String
  actor         String   // agent name, "system", "user"
  details       String   // JSON
  createdAt     DateTime @default(now())
}

model Setting {
  id            String   @id @default(cuid())
  key           String   @unique
  value         String   // JSON-encoded
  updatedAt     DateTime @updatedAt
}
```
