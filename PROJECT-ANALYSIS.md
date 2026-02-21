# Lyra Control — Codebase Analysis

> Generated: 2026-02-21 | Read-only analysis — no code was modified

---

## 1. Project Overview

**Lyra** is an AI-driven development platform that coordinates autonomous AI agent teams across the full software development lifecycle. It acts as an automated Scrum Master, routing work from Jira to Claude Code agents running in isolated git worktrees, managing quality gates, auto-merging PRs, and tracking DORA metrics.

**Lyra Control** (`lyra-control/`) is the Next.js 15 web application that serves as the command center for the entire Lyra ecosystem. It combines project onboarding, agent orchestration, real-time monitoring, DORA metrics, cost tracking, and sprint management into a single app running locally on a Mac mini.

### Key Actors

| Role | Who | Function |
|---|---|---|
| Product Owner | Mike (human) | Sets priorities, reviews metrics, onboards projects |
| Scrum Master | Lyra (OpenClaw + Lyra Control) | Sprint management, task routing, reporting, Jira automation |
| Architect Agent | Claude Code (Opus 4) | PRD/ARD generation, epic/story breakdown |
| Dev Team | Claude Code (Sonnet 4.5) | Feature implementation, bug fixes, unit tests, PRs |
| QA Team | Claude Code (Sonnet 4.5) | Test generation/execution, acceptance validation |

### External Dependencies

| Service | Purpose | Integration Method |
|---|---|---|
| Jira (`mbakers.atlassian.net`) | Work tracking (source of truth) | REST API v3 + Agile API |
| GitHub (`michaelbaker-dev` org) | Code hosting, CI/CD | `gh` CLI + GitHub Actions |
| OpenRouter | Non-coding AI tasks, fallback agent execution | REST API (OpenAI-compatible) |
| Claude Code (Max subscription) | Primary coding agent execution | CLI (`claude -p`) |
| LM Studio (local, `192.168.56.203:1234`) | Fast classification, local inference | OpenAI-compatible API |
| OpenClaw | Lyra identity, iMessage/Teams/Email, cron scheduling | Local instance |

---

## 2. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js 15 (App Router, Server Components, Server Actions) |
| Language | TypeScript (strict mode, ESM) |
| Styling | Tailwind CSS v4 |
| ORM | Prisma (SQLite) |
| Analytics DB | DuckDB (queries SQLite via sqlitescanner — not yet wired) |
| Template Engine | Handlebars (project scaffolding) |
| Testing | Vitest (unit), Playwright (E2E — referenced, not yet configured) |
| Package Manager | npm |
| Runtime | Node.js 18+ |

### Key Dependencies (package.json)

- `next` ^15.0.0, `react` ^19.0.0, `react-dom` ^19.0.0
- `@prisma/client` ^6.0.0, `prisma` ^6.0.0
- `handlebars` ^4.7.0
- `@tailwindcss/postcss` ^4.1.18, `tailwindcss` ^4.0.0
- Dev: `vitest` ^1.0.0, `typescript` ^5.3.0, `eslint-config-next`

---

## 3. Directory Structure

```
~/code/aiSoftware/
├── AI-software.md              # Master design document (architecture, strategy, risks)
├── PRD.md                      # Product Requirements Document
├── ARD.md                      # Architecture Decision Record (10 ADRs)
├── CLAUDE.md                   # Claude Code project instructions
├── .gitignore
├── *.png                       # Various screenshots (onboarding, architect, models UI)
└── lyra-control/               # Next.js 15 web application
    ├── package.json
    ├── next.config.ts
    ├── tsconfig.json
    ├── tailwind.config.ts
    ├── postcss.config.mjs
    ├── diagnose-costs.js        # Cost debugging utility
    ├── .env / .env.example
    ├── prisma/
    │   ├── schema.prisma        # 16 models (see Data Model section)
    │   ├── dev.db / lyra.db     # SQLite databases
    │   └── migrations/          # 7 migrations (init → triage indexes)
    └── src/
        ├── app/
        │   ├── layout.tsx       # Root layout with sidebar, dark theme (gray-950)
        │   ├── page.tsx         # Dashboard home (agent status, work queue, cost, activity)
        │   ├── globals.css
        │   ├── onboarding/      # 8-step wizard (project → GitHub → analysis → architect → breakdown → Jira → scaffold → team → review)
        │   ├── projects/        # Project list + [id] detail (team config, sessions, chat)
        │   ├── agents/          # Agent management + dispatcher controls
        │   ├── sprints/         # Sprint management + demo data
        │   ├── metrics/         # DORA metrics dashboard
        │   ├── costs/           # Cost analytics page
        │   ├── settings/        # 6-tab admin (API keys, models, dispatcher, roles, channels, notifications)
        │   ├── ceremonies/      # Sprint ceremony management
        │   ├── notifications/   # Notification center
        │   ├── blockers/        # Blocker visibility page
        │   ├── triage/          # Failure triage log
        │   └── api/             # API routes (dispatcher, events SSE, onboarding, sessions, sprints, triage, slack, blockers, chat)
        ├── components/          # Shared UI components
        │   ├── sidebar.tsx      # Navigation (12 routes)
        │   ├── agent-status-panel.tsx
        │   ├── work-queue.tsx
        │   ├── cost-ticker.tsx / cost-ticker-live.tsx
        │   ├── activity-feed.tsx
        │   ├── system-health.tsx
        │   ├── model-selector.tsx
        │   ├── project-selector.tsx
        │   └── step-progress.tsx
        ├── lib/                 # Core business logic
        │   ├── db.ts            # Prisma singleton
        │   ├── types.ts         # TypeScript type definitions
        │   ├── dispatcher.ts    # Work dispatcher (Jira → agent spawning)
        │   ├── qa-runner.ts     # QA agent runner
        │   ├── jira.ts          # Jira REST API client
        │   ├── github.ts        # GitHub gh CLI wrapper
        │   ├── openrouter.ts    # OpenRouter API client
        │   ├── openrouter-agent.ts # Tool-loop agent for non-Claude models
        │   ├── lyra-brain.ts    # AI decision engine
        │   ├── lyra-events.ts   # Typed event bus (20+ events)
        │   ├── lyra-chat.ts     # Project chat interface
        │   ├── lyra-oversight.ts # Proactive monitoring
        │   ├── quality-gate.ts  # Multi-stage validation
        │   ├── failure-analyzer.ts # LLM-powered failure triage
        │   ├── cost-tracker.ts  # Centralized cost tracking
        │   ├── cost-projections.ts # Cost projection analytics
        │   ├── merge-queue.ts   # Dependency-ordered PR merging
        │   ├── rollback.ts      # Auto-revert on CI failure
        │   ├── scheduler.ts     # Background task orchestrator
        │   ├── sprint-planner.ts # Sprint management
        │   ├── team-manager.ts  # Dynamic agent scaling
        │   ├── team-templates.ts # Model tier system + team presets
        │   ├── team-rebalancer.ts # Workload rebalancing
        │   ├── role-config.ts   # Data-driven role management
        │   ├── templates.ts     # Handlebars template rendering
        │   ├── ceremonies.ts    # Sprint ceremony automation
        │   ├── codebase-analyzer.ts # Project codebase analysis
        │   ├── work-breakdown.ts # Epic → story breakdown
        │   ├── dod.ts           # Definition of Done
        │   ├── init.ts          # App initialization
        │   ├── notifications.ts # Notification management
        │   ├── process-manager.ts # Process lifecycle
        │   ├── pi-planner.ts    # Program increment planning
        │   ├── launch-generator.ts # Launch script generation
        │   ├── release-notes-generator.ts # Release note generation
        │   ├── tavily.ts        # Tavily search integration
        │   ├── sse.ts           # Server-Sent Events helper
        │   ├── use-sse.ts / use-sse-log.ts # React SSE hooks
        │   ├── messaging/       # Multi-channel messaging
        │   │   ├── index.ts     # Unified send interface
        │   │   ├── queue.ts     # Message queue with retry
        │   │   ├── email.ts     # Email via Graph API
        │   │   ├── imessage.ts  # iMessage integration
        │   │   ├── teams.ts     # Microsoft Teams
        │   │   ├── slack.ts     # Slack integration
        │   │   └── webhook.ts   # Generic webhooks
        │   └── triage-lifecycle.ts # Triage state management
        └── templates/           # Handlebars templates
            ├── claude-md.hbs    # CLAUDE.md for onboarded projects
            ├── ci.yml.hbs       # GitHub Actions CI
            ├── auto-merge.yml.hbs # Auto-merge workflow
            ├── rollback.yml.hbs # Post-merge rollback workflow
            ├── pr-template.hbs  # PR template with Jira linking
            ├── lyra-launch.sh.hbs # Launch script
            ├── lyra-personality.hbs # Lyra personality prompt
            └── release-notes.md.hbs # Release notes template
```

---

## 4. Data Model (Prisma Schema — 16 Models)

### Core Models

| Model | Purpose | Key Fields |
|---|---|---|
| **Project** | Onboarded software projects | name, path, jiraKey, githubRepo, techStack, codebaseAnalysis, activeSprintId, archProfile, baseBranch |
| **Agent** | AI agent instances | name, role, model, status (idle/running/errored/rate-limited), personality, teamId |
| **Team** | Agent teams with routing | specialization, model, systemPrompt, routingLabels, routingPriority, isDefault |
| **Session** | Individual agent work sessions | ticketKey, branch, worktreePath, status, tokensUsed, cost, prompt, output |
| **Sprint** | Jira sprint tracking | jiraSprintId, goal, state, plannedPoints, completedPoints |

### Quality & Tracking Models

| Model | Purpose |
|---|---|
| **QualityGateRun** | Per-session quality validation results (checks, reasoning, pass/fail) |
| **TriageLog** | Failure analysis records (category, action, rootCause, confidence, resolution) |
| **AiUsageLog** | Granular LLM cost tracking (provider, model, tokens, cost, category, duration) |
| **AuditLog** | Action audit trail (actor, action, details JSON) |

### Communication & Configuration Models

| Model | Purpose |
|---|---|
| **LyraMemory** | Lyra's persistent memory (decisions, observations, reflections) |
| **Notification** | In-app/email/webhook notifications with severity |
| **MessageQueue** | Multi-channel outbound messages with retry |
| **ChatMessage** | Project-scoped chat history |
| **SlackThread** | Slack thread tracking for ceremonies/tickets |
| **Setting** | Key-value configuration store |
| **RoleConfig** | Data-driven agent role definitions |
| **TeamTemplate** | Preset team configurations |

### Schema Evolution (7 Migrations)

1. `init` — Core tables (Project, Agent, Session, AuditLog, Setting)
2. `add_architect_fields` — PRD/ARD content, vision, target users
3. `add_onboarding_step` — Step tracking for wizard
4. `add_ai_usage_tracking` — AiUsageLog, LyraMemory, QualityGateRun, Notification, MessageQueue
5. `add_sprint_scrum_fields` — Sprint, ceremonies, chat, Slack threads
6. `add_arch_profile` — Architecture profile, base branch, environments, teams
7. `add_triage_ticket_summary_and_index` — Triage enhancements with indexes

---

## 5. Architecture Patterns

### 5.1 Event-Driven Architecture

The system is built around `lyra-events.ts`, a typed Node.js EventEmitter that decouples all components. 20+ event types flow through it:

- **Agent lifecycle**: `agent:completed`, `agent:failed`, `agent:output`
- **Quality**: `gate:passed`, `gate:failed`
- **Git/PR**: `pr:created`, `pr:merged`
- **Tickets**: `ticket:abandoned`, `qa:assigned`
- **Intelligence**: `lyra:decision`, `failure:analyzed`
- **Operations**: `cost:update`, `notify`

This enables real-time SSE streaming to the dashboard and loose coupling between orchestration components.

### 5.2 Dispatcher Pattern (Core Work Loop)

The dispatcher (`dispatcher.ts`) is the heart of the system:

1. Polls Jira for "To Do" tickets in the active sprint (every 5 min default)
2. Checks blocking dependencies via Jira issue links
3. Routes tickets to teams using 3-tier routing: label match → AI classification → default fallback
4. Creates git worktrees for isolation
5. Spawns Claude Code agents (or OpenRouter agents for non-Claude models)
6. Monitors agent health (2-hour timeout, kill stuck agents)
7. On completion: runs quality gate → push/PR → auto-merge → Jira transitions
8. On failure: triage analysis → retry with escalated model

### 5.3 Model Tier Escalation

A 3-tier model system escalates on failure:

| Tier | Model | When |
|---|---|---|
| Tier 1 | claude-sonnet-4-5 | First 2 attempts |
| Tier 2 | claude-sonnet-4-5 (or configurable) | Attempts 2-3 |
| Tier 3 | claude-opus-4 (or openrouter/auto fallback) | Attempts 4+ |

Configurable via Settings UI. Supports Claude CLI (native) and OpenRouter (non-Claude models including DeepSeek, LM Studio locals).

### 5.4 Quality Gate Pipeline

Before any PR is created, work passes through a multi-stage quality gate:

1. **Commits exist** — Branch must have new commits beyond base
2. **TypeScript compiles** — `npx tsc --noEmit` must pass
3. **Tests pass** — `npm test` / framework-appropriate test runner
4. **Acceptance criteria met** — Lyra Brain AI validates against ticket criteria

Failed gates send tickets back to "To Do" with detailed failure analysis.

### 5.5 Failure Recovery Flow

When agents fail or quality gates reject work:

1. **Failure Analyzer** (LLM-powered) classifies the error: build_error, test_failure, type_error, timeout, dependency_issue, etc.
2. Recommends action: retry_same_team, reassign_team, create_bug, escalate_to_po
3. Injects previous failure context into retry prompts so agents don't repeat mistakes
4. Circuit breaker: max 5 retries per ticket, then abandons with notification
5. Abandon cascade: notifies dependent tickets that their blocker is stuck

### 5.6 State Persistence Across HMR

Dispatcher, QA runner, and scheduler state survive Next.js Hot Module Replacement via the globalThis singleton pattern (same as Prisma):

```typescript
const globalForDispatcher = globalThis as unknown as { __dispatcherState: DispatcherState | undefined };
const state = globalForDispatcher.__dispatcherState ?? { /* defaults */ };
if (process.env.NODE_ENV !== "production") globalForDispatcher.__dispatcherState = state;
```

### 5.7 Multi-Channel Messaging

Lyra can communicate via 6 channels, each with its own adapter in `src/lib/messaging/`:

- **In-app** notifications (default)
- **Email** (Microsoft Graph API via lyra@baker.email)
- **iMessage** (via OpenClaw bridge)
- **Microsoft Teams** (Bot Framework)
- **Slack** (Bot API with thread tracking)
- **Webhook** (generic HTTP POST)

Messages are queued in `MessageQueue` with retry logic. Channel routing is severity-based (info → in-app, warning → Slack, critical → email + Slack).

---

## 6. Key Workflows

### 6.1 Project Onboarding (8-Step Wizard)

1. **Project Info** — Name, path, Jira key, tech stack, description, vision
2. **GitHub Setup** — Create private repo in `michaelbaker-dev` org, set branch protection
3. **Codebase Analysis** (conditional) — If existing repo, analyze framework/dependencies/structure
4. **Architect** — Generate PRD and ARD using Claude Opus 4
5. **Work Breakdown** — Break PRD into epics and stories with acceptance criteria
6. **Jira Setup** — Create project, custom fields, workflow, import stories
7. **File Scaffolding** — Generate CLAUDE.md, CI workflows, PR template from Handlebars templates
8. **Team Setup** — Configure agent teams with roles, models, specializations
9. **Review & Execute** — Validate full cycle

### 6.2 Ticket Lifecycle

```
Backlog → To Do → [Dispatcher picks up] → In Progress (agent working)
  → Agent completes → Quality Gate
    → PASS: Push → PR → Auto-merge → Code Review → QA → QA Passed → Done
    → FAIL: Back to To Do with failure context → Retry (escalated model)
  → Agent fails → Failure triage → Back to To Do → Retry
  → Max retries exceeded → Abandoned (human intervention required)
```

### 6.3 Sprint Ceremonies (Automated)

- **Sprint Planning**: Bi-weekly, pulls from backlog
- **Daily Standup**: Automated status report via configured channels
- **Sprint Review**: Completed work summary + DORA metrics
- **Retrospective**: Failure analysis, cost trends, improvement recommendations

---

## 7. UI Pages (12 Routes)

| Route | Page | Description |
|---|---|---|
| `/` | Dashboard | Agent status, work queue (Kanban), cost ticker, activity feed, system health |
| `/onboarding` | Onboarding Wizard | Multi-step project setup flow |
| `/projects` | Project List | All onboarded projects with health indicators |
| `/projects/[id]` | Project Detail | Team config, sessions, chat panel, session detail |
| `/sprints` | Sprint Manager | Sprint planning and tracking |
| `/agents` | Agent Management | Live agents, dispatcher controls (start/stop/config) |
| `/ceremonies` | Sprint Ceremonies | Ceremony scheduling and execution |
| `/notifications` | Notification Center | In-app notifications with severity |
| `/blockers` | Blockers | Dependency blockers across projects |
| `/triage` | Triage Log | Failure analysis records |
| `/metrics` | DORA Metrics | Deployment frequency, lead time, failure rate, recovery time |
| `/costs` | Cost Analytics | LLM spend by provider, model, project, category |
| `/settings` | Settings | API keys, model tiers, dispatcher config, roles, channels |

---

## 8. API Routes

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/dispatcher` | GET/POST | Get dispatcher state, start/stop/config/trigger dispatch |
| `/api/events` | GET | SSE stream for real-time dashboard updates |
| `/api/onboarding/execute-step` | POST | Execute individual onboarding steps |
| `/api/onboarding/execute` | POST | Execute full onboarding |
| `/api/sessions/[id]` | GET/POST | Session details, retry with custom prompt |
| `/api/sprints` | GET/POST | Sprint management |
| `/api/triage` | GET | Triage log data |
| `/api/blockers` | GET | Blocker data |
| `/api/projects/[id]/chat` | POST | Project-scoped chat with Lyra |
| `/api/slack/events` | POST | Slack event webhook receiver |

---

## 9. Configuration (Settings)

### API Keys (stored in Prisma `Setting` table, masked in UI)
- `jira_email`, `jira_api_token` — Jira authentication
- `github_token` — Default GitHub PAT (per-project overrides possible)
- `openrouter_api_key` — OpenRouter API
- `lm_studio_url` — Local LM Studio endpoint
- `tavily_api_key` — Tavily search

### Dispatcher Config
- `dispatcher_poll_interval` — Minutes between Jira polls (default: 5)
- `dispatcher_max_agents` — Max concurrent agents (default: 8)
- `dispatcher_max_retries` — Max failures before abandoning ticket (default: 5)

### Model Tier Config
- Tier 1/2/3 models for agents (escalation on failure)
- Support models: routing, triage, quality gate, ceremonies
- Per-project and per-team model overrides

---

## 10. Development Notes

### Running the App
```bash
cd lyra-control && npm run dev
# App runs at http://localhost:3000
```

### Critical Rules (from CLAUDE.md)
- **NEVER** run `npx next build` while dev server is running — breaks static assets
- Only one Next.js process at a time
- If page appears unstyled: kill all next processes → `rm -rf .next` → restart

### Database Commands
```bash
npx prisma migrate dev    # Run migrations
npx prisma generate       # Generate client
```

### Commit Convention
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`
- Branch naming: `feat/TICKET-NNN-description`, `fix/TICKET-NNN-description`
- Always include Jira ticket ID in commit messages

---

## 11. Implementation Status Assessment

### Fully Implemented
- Project onboarding wizard (8 steps with real-time progress)
- Dispatcher service (Jira polling → agent spawning → completion handling)
- QA runner service
- Quality gate pipeline (commits, TypeScript, tests, AI validation)
- Failure analyzer with LLM triage
- Multi-channel messaging (email, iMessage, Teams, Slack, webhook)
- Cost tracking across all providers
- Model tier escalation system
- Team-based agent routing
- Sprint management
- Lyra Brain decision engine with memory
- Dashboard with real-time SSE updates
- Settings with 6 configuration tabs
- Merge queue with dependency ordering
- Auto-rollback on CI failure
- 12 UI pages with full navigation

### Partially Implemented / Needs Validation
- DuckDB analytics (referenced but not wired into queries)
- E2E testing with Playwright (referenced, not configured)
- Docker Compose environment management (schema supports it, not fully wired)
- DORA metrics may need real data to validate calculations
- OpenClaw integration (communication layer — separate system)

### Architecture Strengths
- Clean separation of concerns via event bus
- Graceful degradation (fallback models, circuit breakers)
- Rich failure context for retries (prevents repeating mistakes)
- Team-scoped routing with AI classification fallback
- Cost-aware at every layer
- Per-project configuration overrides

### Potential Areas of Attention
- SQLite write concurrency under heavy agent load (WAL mode helps)
- Claude Max rate limits (~900 messages / 5hr window) are a hard constraint
- globalThis state doesn't survive full process restarts (only HMR)
- Worktree cleanup relies on scheduled task
