# Lyra: AI-Driven Development Platform — Research & System Design

## Context

You want Lyra (running on OpenClaw) to act as a project manager coordinating multiple AI agent teams across the full software development lifecycle. Work flows through Jira at `mbakers.atlassian.net`. You interact via dedicated iMessage/Teams channels per project, or email at lyra@baker.email. The first project is AgentDog. Agents should autonomously implement, test, merge, and fix — no human in the loop except for strategic direction. A management application (Lyra Control) should provide visibility into everything: onboarding, metrics, model selection, agent health, and DORA metrics.

---

## Part 1: OpenClaw Audit — What You Already Have

Your OpenClaw instance at `~/openclaw` is operational with Lyra configured:

| Capability | Status | Details |
|---|---|---|
| Lyra identity | Working | SOUL.md, IDENTITY.md, MEMORY.md in `~/.openclaw/workspace/` |
| iMessage | Working | Pairing policy, allowlist groups |
| Microsoft Teams | Working | Bot App ID `5c384f3c`, tenant `763c82b0` |
| Email (Graph API) | Working | lyra@baker.email, webhook on :3980 |
| Cron/Heartbeat | Working | Email processor (60s), inbox triage (hourly) |
| Subagents | Working | Up to 8 concurrent via OpenRouter/auto |
| Mission Control | Disabled | Builder/QA/Release cron jobs exist but are off |
| Kanban board | Exists | In-memory JSON, web UI at :3000 |
| ClickUp skill | Installed | API key configured |
| **Jira integration** | **Not installed** | No skill exists locally |
| **Multi-agent teams** | **Not supported** | Single agent + subagents only; Agent Teams RFC #10036 is unimplemented |

### Models Available
- **Cloud primary**: OpenRouter/auto (auto-selects best model)
- **Cloud fallback**: Claude Haiku 4.5 via OpenRouter
- **Local**: MiniMax M2.5, Kimi K2, Kimi Dev 72B, DeepSeek V3 via LM Studio at 192.168.56.203:1234

### Mission Control Pattern (Already Prototyped)
You already have a disabled prototype of this exact pattern:
- **Builder cron** (30 min): Picks oldest "Todo" kanban card, implements, commits to develop, moves to "Review"
- **QA cron** (30 min): Runs 3-tier tests, creates PRs or files issues
- **Release Tagger** (hourly): Tags releases, generates changelog

This is what you want — but using JSON kanban instead of Jira, and limited to a single agent.

---

## Part 2: Honest Assessment — Should You Use OpenClaw?

### What OpenClaw Does Well

1. **Communication hub**: Already connected to iMessage, Teams, email — working today
2. **Heartbeat/cron scheduling**: Wake-up-and-check-for-work pattern is built-in
3. **Persistent identity**: SOUL.md/MEMORY.md gives Lyra continuity
4. **Skill system**: Clean plugin model. **DO NOT USE ClawHub** (`clawhub install jira`) — 36% of ClawHub skills contain prompt injection, 341 of 5,705 are outright malicious. Build the Jira skill yourself.
5. **Chat-to-task intake**: "MC:" or "task:" prefixes in chat already create kanban cards

### What OpenClaw Cannot Do Today

1. **True multi-agent teams**: Subagents are isolated fire-and-forget. They can't coordinate, share state, or form persistent teams. Agent Teams RFC #10036 is a proposal, not code.
2. **Deep code development**: OpenClaw sends prompts to LLMs and gets text back. It doesn't navigate codebases, run tests iteratively, or fix errors in loops the way Claude Code does.
3. **Parallel worktree development**: No concept of git worktrees or parallel branch isolation.
4. **Environment provisioning**: No dev/QA/prod concept. No Docker orchestration.
5. **Auto-merge with rollback**: No merge queue, CI integration, or rollback automation.

### Security Concerns (Important Context)

OpenClaw (released ~3 weeks ago) has significant security issues documented by multiple outlets:
- 512 vulnerabilities found in initial audit, 8 critical (The Register, Feb 2026)
- 36% of ClawHub skills contain prompt injection; 341 of 5,705 are outright malicious
- One-click RCE via unvalidated WebSocket origin headers
- 135,000+ internet-exposed instances, ~1,000 without authentication

**Your mitigation**: Local network only, Tailscale off, token auth. This is adequate for now, but avoid installing untrusted ClawHub skills. Build the Jira skill yourself.

### The Core Question: OpenClaw vs Claude Code vs Build From Scratch

| Approach | Verdict |
|---|---|
| **Pure OpenClaw** | Not viable. Multi-agent teams don't exist. Code development capability is shallow. |
| **Build from scratch** | Overkill. Rebuilds messaging/cron/identity infrastructure that already works. |
| **Hybrid: OpenClaw + Claude Code** | **Recommended.** Lyra handles communication and scheduling. Claude Code handles development. |

---

## Part 3: Recommended Architecture

### High-Level Topology

```
                           YOU
              (iMessage / Teams / Email / Jira)
                            |
                   ┌────────▼────────┐
                   │      LYRA       │  OpenClaw
                   │ (Scrum Master)  │  Communication, scheduling, Jira, routing
                   └────────┬────────┘
                            |
               ┌────────────┼────────────┐
               ▼            ▼            ▼
         ┌──────────┐ ┌──────────┐ ┌──────────┐
         │ Architect│ │ Dev Team │ │ QA Team  │   Claude Code instances
         │  Agent   │ │ (1..N)   │ │          │   in git worktrees
         └────┬─────┘ └────┬─────┘ └────┬─────┘
              │            │            │
              ▼            ▼            ▼
           PRD/ARD      Feature      Test Results
           Jira Epics   Branches     Jira Comments
                            │            │
                            ▼            ▼
                     ┌─────────────────────┐
                     │   Auto-Merge Queue  │
                     │  (merge → test →    │
                     │   rollback → fix)   │
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │    JIRA (SoT)       │  All work tracked here
                     └──────────┬──────────┘
                                │
                     ┌──────────▼──────────┐
                     │   Lyra Control      │  Onboarding, metrics, DORA,
                     │  (Next.js 15 App)   │  model config, agent health
                     └─────────────────────┘
```

### Layer 1: Communication (OpenClaw / Lyra)

**Role**: Receive messages, parse intent, manage Jira, route work to agent teams. Lyra acts as **Scrum Master** — managing sprint ceremonies, routing work, and reporting status.

**Project routing**: Dedicated iMessage/Teams channels per project. Channel-to-project mapping stored in config. Lyra knows which project based on which channel the message arrives in.

**Task intake examples**:
- "There's a bug with metric ingestion timing out" → Lyra creates Jira Bug in ADOG project
- "Add a cost calculator to the dashboard" → Lyra creates Jira Story, assigns to dev team
- "What's the status of the auth refactor?" → Lyra queries Jira, responds in chat

**Jira skill**: Custom-built OpenClaw skill (not from ClawHub) wrapping Jira REST API v3 for create/query/transition/comment operations via `https://mbakers.atlassian.net`.

### Layer 2: Work Orchestration (Dispatcher Service)

The dispatcher is a **TypeScript service** running within the Lyra Control Next.js process — not shell scripts. It is managed via API routes and can be started/stopped from the UI.

**Work loop** (polls every 15 min):
1. Query Jira for tickets in "To Do" status
2. Determine team assignment (dev/QA/arch) from ticket type and workflow position
3. Check if PRD/ARD exists for the project; if not, route to Architect first
4. Create git worktree for the ticket: `git worktree add worktrees/{team}-{TICKET} -b {type}/{TICKET}`
5. Spawn Claude Code in the worktree with ticket context via `claude -p`
6. Update Jira: status → In Progress, comment with agent assignment
7. On completion: push branch, create PR, transition Jira ticket

**Handoff flow**:
```
Backlog → To Do → In Progress (Dev) → Code Review (auto-PR) → QA → QA Passed → Done
                                           │                      │
                                     auto-merge attempt      QA agent runs
                                           │                 tests, reports
                                     if fails → fix → retry    │
                                                          pass/fail → Jira
```

### Layer 3: Development Engine (Claude Code)

Claude Code is the execution engine because it has capabilities OpenClaw's LLM calls don't:
- Deep file-aware codebase navigation
- Iterative test-run-fix loops
- Tool use (Read, Edit, Grep, Glob, Bash)
- Session resumption for long-running tasks

**Headless operation via CLI** (full autonomy mode):
```bash
claude -p "Implement ADOG-305: Add cost calculator component. See ticket description for requirements." \
  --dangerously-skip-permissions \
  --append-system-prompt "Working in $(pwd). Project: AgentDog. Commit with ticket ID in message." \
  --output-format stream-json
```

> **Note**: Use `--dangerously-skip-permissions` for full agent autonomy. Do NOT use `--allowedTools` — it is too restrictive for autonomous agents that need to install dependencies, run arbitrary commands, and self-correct.

**Session continuity**: Each ticket gets a `claude-progress.txt` in its worktree (Anthropic's recommended pattern for long-running agents). If a session is interrupted or stalled, the next cron cycle reads progress and resumes.

**Claude Code Max subscription**: Your Max plan provides ~900 messages per 5-hour window. Multiple concurrent sessions draw from the same pool, so the dispatcher should limit concurrent agents (3-4 recommended from research and practical rate limit constraints).

### Layer 4: Auto-Merge with Rollback

The full autonomous cycle:

```
1. Dev agent pushes feature branch, creates PR
2. CI runs (GitHub Actions)
3. If CI passes → auto-merge to main
4. Post-merge smoke tests run
5. If post-merge fails:
   a. Auto-revert the merge commit (git revert)
   b. Create new Jira bug: "Merge regression in {TICKET}"
   c. Dev agent picks up the bug, investigates, fixes
   d. New PR → repeat from step 2
6. If post-merge passes → deploy to QA environment
7. QA agent runs full test suite
8. If QA passes → deploy to prod (optionally behind feature flag)
9. If QA fails → Jira bug → dev agent fixes → repeat
```

**Tools to consider**:
- **Aviator MergeQueue**: Manages merge ordering, tests PRs against latest main + queued PRs, handles flaky tests
- **Feature flags** (LaunchDarkly/FeatBit/Unleash): Merge code behind flags, toggle instantly if problems detected, no redeploy needed
- **Clash**: Detects conflicts across worktrees before merge attempts

### Layer 5: Testing Strategy (QA Team)

| Layer | Tool | When | Agent |
|---|---|---|---|
| Unit tests | Go test / Jest / Vitest | Every commit | Dev agent (writes + runs) |
| API tests | Cucumber (BDD) | QA phase | QA agent (generates feature files, runs) |
| E2E tests | Playwright | QA phase | QA agent (generates + runs via Playwright MCP) |
| Conflict detection | Clash | Before merge | Dispatcher service |
| Smoke tests | Custom scripts | Post-merge | CI pipeline |

The QA agent:
1. Checks out the feature branch into a QA worktree
2. Spins up `docker-compose.qa.yml`
3. Runs existing unit tests + generates new ones for changed code
4. Writes Cucumber feature files for API changes
5. Writes Playwright tests for UI changes
6. Reports pass/fail as Jira comments with logs
7. Transitions ticket to "QA Passed" or back to "To Do" with failure details

**Installation**: Dev/QA agents install whatever dependencies are needed (npm, go modules, playwright browsers, cucumber). They have permission to run install commands.

### Layer 6: PRD/ARD Workflow

```
Project Onboarding Decision Tree:

1. Does a PRD exist in the repo?
   ├── Yes → Architect reads it
   └── No → Does a Jira epic/description exist?
       ├── Yes → Architect generates PRD from Jira description
       └── No → You provide a brief → Architect generates PRD

2. Does an ARD (Architecture Decision Record) exist?
   ├── Yes → Architect validates it against PRD
   └── No → Architect generates ARD from PRD

3. Architect breaks down into:
   Phases → Epics → Stories (with acceptance criteria)
   All posted to Jira automatically

4. Dev teams start picking up stories from Jira
```

For AgentDog: `PRD.md` and `Phase1-Plan.md` already exist in the repo. The Architect agent would read these and populate Jira.

---

## Part 3A: Agile Role Mapping

Lyra maps standard Agile roles to AI agents:

| Agile Role | Who | Responsibilities |
|---|---|---|
| **Product Owner** | Mike (human) | Sets vision, priorities, and acceptance criteria. Reviews metrics. Communicates via iMessage/Teams/email. |
| **Scrum Master** | Lyra (OpenClaw) | Manages sprint ceremonies (automated via cron), routes work, removes blockers, reports status, enforces workflow. |
| **Tech Lead / Architect** | Claude Code (Opus 4) | Generates PRD/ARD, breaks down epics into stories, reviews architecture decisions, validates technical approach. |
| **Dev Team** | Claude Code (Sonnet 4.5) | Implements features, fixes bugs, writes unit tests, creates PRs. Runs in isolated git worktrees. |
| **QA Team** | Claude Code (Sonnet 4.5) | Generates and runs tests (unit, API/Cucumber, E2E/Playwright), reports results, transitions tickets. |

### Decision Authority

| Decision Type | Authority | Escalation |
|---|---|---|
| What to build | Product Owner (Mike) | — |
| Sprint priorities | Scrum Master (Lyra) | Product Owner |
| Architecture | Architect Agent | Product Owner |
| Implementation approach | Dev Agent | Architect Agent |
| Quality gate (pass/fail) | QA Agent | Scrum Master |
| Production deploy | Auto (if QA passes) | Product Owner (if failure rate > threshold) |

---

## Part 3B: Sprint Ceremonies (Automated)

All sprint ceremonies are automated via OpenClaw cron jobs:

| Ceremony | Frequency | Implementation | Output |
|---|---|---|---|
| **Sprint Planning** | Bi-weekly (Monday 9am) | Lyra queries Jira backlog, prioritizes by PO input, assigns to sprint | Sprint board populated in Jira |
| **Daily Standup** | Daily (9am) | Lyra queries all In Progress tickets, checks agent health, reports blockers | Status message to Teams/iMessage |
| **Sprint Review** | Bi-weekly (Friday 3pm) | Lyra compiles completed work, DORA metrics, velocity | Summary report to PO |
| **Retrospective** | Bi-weekly (Friday 4pm) | Lyra analyzes failure rates, retry counts, stale tickets, cost overruns | Improvement recommendations |

### Cron Job Definitions

```
# Sprint ceremonies
0 9 * * 1 sprint-planning    # Bi-weekly sprint planning (Monday)
0 9 * * * daily-standup       # Daily standup report
0 15 * * 5 sprint-review      # Bi-weekly sprint review (Friday)
0 16 * * 5 sprint-retro       # Bi-weekly retrospective (Friday)

# Operational
*/15 * * * * work-dispatcher   # Poll Jira for To Do tickets
*/15 * * * * qa-runner         # Poll Jira for QA tickets
0 * * * * status-reporter      # Hourly status summary
*/30 * * * * stale-checker     # Check for stuck tickets
0 2 * * * worktree-cleanup     # Clean merged worktrees (2am daily)
```

---

## Part 4: Multi-Model Strategy

### Model Routing by Task Type

| Task | Model | Rationale |
|---|---|---|
| Architecture design, PRD/ARD creation | Claude Opus 4 (via Max) | Deep reasoning, long context, strategic thinking |
| Code implementation, refactoring | Claude Sonnet 4.5 (via Max or OpenRouter) | Best balance of capability and throughput |
| Simple fixes, formatting, typos | Claude Haiku 4.5 (via OpenRouter) | Fast, cheap, sufficient quality |
| Lyra's chat responses, task routing | OpenRouter/auto | Good enough for conversation, cost-efficient |
| Code review, security analysis | Claude Sonnet 4.5 | Needs domain knowledge, not max reasoning |
| Test generation | Claude Sonnet 4.5 | Needs code understanding but not deep architecture reasoning |
| Classification, routing decisions | Local models (MiniMax M2.5) | Free, fast, low-latency for simple decisions |

### How Models Are Used

- **Claude Code Max** (your subscription): Primary engine for all dev/QA/architect agents. The `claude` CLI uses your Max subscription automatically. ~900 messages per 5-hour window shared across all concurrent sessions.
- **OpenRouter/auto**: Used by Lyra (OpenClaw) for conversational responses, Jira management, task parsing. Auto-selects the best model per prompt.
- **Local LM Studio models**: Used for fast classification tasks (is this a bug or feature? which project? what priority?) where latency matters and quality bar is low.

### OpenRouter/auto API Usage

```typescript
// Task routing via OpenRouter/auto
const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://lyra.local",
    "X-Title": "Lyra Control"
  },
  body: JSON.stringify({
    model: "openrouter/auto",
    messages: [{ role: "user", content: prompt }]
  })
});
const data = await response.json();
```

**Task routing rules**:
- If task requires code changes → Claude Code (Max subscription)
- If task is conversational/routing → OpenRouter/auto
- If task is simple classification → Local LM Studio model
- If OpenRouter/auto fails → fallback to Claude Haiku 4.5 via OpenRouter

### Configuration in the Management App

The app should allow you to:
- Set default model per agent role (Architect, Dev, QA)
- Override model for specific projects or ticket types
- View cost per model per day/week/month
- Set alerts when approaching rate limits
- Switch between Max subscription and OpenRouter API key billing

---

## Part 5: Jira Project Structure

### Per-Project Setup (Created by Onboarding Wizard)

```
Jira Project: ADOG (AgentDog)
│
├── Workflow: Backlog → To Do → In Progress → Code Review → QA → QA Passed → Done
│
├── Issue Types: Epic, Story, Bug, Subtask
│
├── Custom Fields:
│   ├── Agent Team: dev / qa / architect
│   ├── Target Environment: dev / qa / prod
│   ├── Agent Status: waiting / running / blocked / completed / failed
│   ├── Agent Session ID: Claude Code session ID for resumption
│   ├── Worktree Branch: git branch name
│   └── Cost (tokens): Total tokens consumed
│
├── Automation Rules:
│   ├── Issue created → Webhook POST to Lyra dispatcher endpoint
│   ├── Issue moved to "To Do" → Notify Lyra to schedule
│   ├── Issue moved to "QA" → Assign to QA agent
│   ├── Issue moved to "Done" → Notify you via Teams/iMessage
│   └── Issue stale (In Progress > 2 hours) → Alert Lyra to investigate
│
└── Board: Kanban view with swimlanes by Agent Team
```

### Jira API Integration

Authentication: Basic Auth with your Atlassian email + API token.

Key operations the Jira skill performs:
- `POST /rest/api/3/issue` — Create epic/story/bug
- `PUT /rest/api/3/issue/{key}` — Update fields
- `POST /rest/api/3/issue/{key}/transitions` — Move through workflow
- `POST /rest/api/3/issue/{key}/comment` — Add agent activity logs
- `GET /rest/api/3/search?jql=...` — Query for work (e.g., `project=ADOG AND status="To Do" AND "Agent Team"=dev`)
- `GET /rest/api/3/field` — Discover custom field IDs (epic link field varies per instance)

---

## Part 5A: GitHub Integration

### Repository Management

All project repos are created in the `michaelbaker-dev` GitHub organization as private repositories.

**Repo creation** (via `gh` CLI during onboarding):
```bash
gh repo create michaelbaker-dev/<project-name> --private --description "<description>"
```

### Branch Protection Rules

Applied to `main` and `develop` branches:

```bash
gh api repos/michaelbaker-dev/<repo>/branches/main/protection -X PUT -f '{
  "required_status_checks": {
    "strict": true,
    "contexts": ["ci"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}'
```

Rules:
- **Require CI passing**: No merge without green CI
- **Require PR**: No direct push to main/develop
- **No force push**: Preserve history
- **No branch deletion**: Protect main branches
- **0 approvals required**: Agents auto-merge (trust the CI)

### PR Workflow

1. Agent creates feature branch: `feat/TICKET-123-description`
2. Agent pushes commits with ticket ID in message
3. Agent creates PR via `gh pr create --title "TICKET-123: Description" --body "..."`
4. CI runs automatically on PR
5. If CI passes → auto-merge via `gh pr merge --auto --squash`
6. If CI fails → agent receives failure output, fixes, pushes again

### Jira-GitHub Linking

PRs and commits reference Jira ticket keys. Jira's GitHub integration (via smart commits) auto-links:
- Commit message: `feat(ADOG-305): add cost calculator component`
- PR title: `ADOG-305: Add cost calculator component`
- PR body includes: `Jira: https://mbakers.atlassian.net/browse/ADOG-305`

---

## Part 5B: CI/CD Pipeline Design

Three GitHub Actions workflows are scaffolded per project during onboarding:

### 1. CI Pipeline (`ci.yml`)

```yaml
name: CI
on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main, develop]

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run lint
      - run: npm run test
      - run: npm run build
```

### 2. Auto-Merge Pipeline (`auto-merge.yml`)

```yaml
name: Auto-Merge
on:
  check_suite:
    types: [completed]

jobs:
  auto-merge:
    if: github.event.check_suite.conclusion == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Auto-merge passing PRs
        run: |
          gh pr list --state open --json number,title --jq '.[].number' | while read pr; do
            gh pr merge "$pr" --auto --squash
          done
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

### 3. Rollback Pipeline (`rollback.yml`)

```yaml
name: Post-Merge Smoke Test & Rollback
on:
  push:
    branches: [main]

jobs:
  smoke-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test:smoke

  rollback:
    needs: smoke-test
    if: failure()
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2
      - name: Revert last merge
        run: |
          git revert HEAD --no-edit
          git push origin main
```

---

## Part 6: Lyra Control — The Management Application

Lyra Control is the web-based command center for the entire Lyra ecosystem. It combines project onboarding, real-time monitoring, DORA metrics, and agent management into a single application. **Onboarding IS the management app** — there is no separate onboarding tool.

### Technology Stack

**Next.js 15 + TypeScript + Tailwind CSS + SQLite + DuckDB**

Why:
- Mission Control (in OpenClaw) is already Next.js — consistent stack
- Next.js 15 App Router with Server Components for real-time dashboard
- Server Actions for onboarding wizard steps
- **SQLite** (via Prisma) for relational data — zero infrastructure, no database server
- **DuckDB** for analytics queries — 10-100x faster than SQLite for time-series aggregations
- DuckDB queries SQLite directly via `sqlitescanner` extension (no ETL needed)
- Single-user local app on Mac mini doesn't need PostgreSQL

### Core Features

#### 1. Onboarding Wizard (6-Step Web Flow)
See Part 7 for full details. The onboarding wizard is the entry point for all new projects — a 6-step web-based flow that creates GitHub repos, Jira projects, scaffolds files, configures dispatchers, and validates the full cycle.

#### 2. Dashboard (Home)
- **Agent Status Panel**: All agents with current state (idle, running, errored, rate-limited), current ticket, elapsed time
- **Work Queue**: Jira tickets by status with agent assignments
- **Active Sessions**: Claude Code sessions currently running, token consumption in real-time
- **Cost Ticker**: Today's spend, this week, this month — broken down by model and agent
- **System Health**: OpenClaw status, Claude Max budget remaining, Jira API health

#### 3. Project Management
- **Project Registry**: All onboarded projects with health indicators (green/yellow/red)
- **Per-Project Sprint Board**: Kanban view from Jira
- **Agent Assignment View**: Which agent is working on which ticket
- **Velocity Chart**: Story points per sprint
- **Environment Status**: Docker container health
- **Recent PRs**: Pull requests with CI status badges

#### 4. DORA Metrics & Analytics
- **Deployment Frequency**: How often agents successfully merge to main (per day/week)
- **Lead Time for Changes**: Time from Jira ticket creation to merge
- **Change Failure Rate**: % of merges that required rollback
- **Failed Deployment Recovery Time**: Time from failure detection to successful fix
- **AI-Specific Metrics**: Agent success rate, auto-merge rate, cost per ticket, tokens per story point, retry count, utilization, stale ticket count
- All powered by **DuckDB** analytical queries against SQLite data

#### 5. Activity Log & Audit Trail
- **Timeline View**: Every agent action chronologically
- **Session Transcripts**: Link to Claude Code session logs
- **Jira Sync Status**: Last sync time, failures, webhook health

#### 6. Settings
- **API Keys**: Jira, OpenRouter (masked display, rotatable)
- **Model Assignment**: Default model per agent role, per-project overrides
- **Concurrency Limits**: Max parallel agents
- **Cron Schedule**: Dispatcher, QA runner, reporter intervals
- **Channel Mappings**: Teams/iMessage channels → projects
- **Notification Preferences**: What gets reported, via which channel

### Per-Project CLAUDE.md Generation

During onboarding, Lyra Control generates a project-specific `CLAUDE.md` file from a Handlebars template. This file provides Claude Code agents with project context:

```handlebars
# {{projectName}}

## Project
- Jira: {{jiraKey}} at mbakers.atlassian.net
- GitHub: michaelbaker-dev/{{githubRepo}}
- Tech Stack: {{techStack}}

## Conventions
- Commit format: {{commitFormat}}
- Branch naming: feat/{{jiraKey}}-NNN-description, fix/{{jiraKey}}-NNN-description
- Always include Jira ticket ID in commit messages

## Commands
{{#each commands}}
- {{this.name}}: `{{this.command}}`
{{/each}}
```

### Database Architecture

**SQLite** (via Prisma ORM):
- Projects, agents, sessions, audit logs, settings
- ACID transactions, relational integrity
- Zero infrastructure — just a file

**DuckDB** (for analytics):
- DORA metric aggregations
- Cost tracking over time
- Time-series queries (deployment frequency, lead time trends)
- Queries SQLite directly — no data duplication

### Data Sources

| Data | Source | Collection Method |
|---|---|---|
| Ticket metrics | Jira REST API | Periodic polling (every 5 min) |
| Agent sessions | Claude Code `--output-format stream-json` | Parse session output |
| Git activity | GitHub API / `gh` CLI | Webhook on push/PR/merge |
| Test results | CI pipeline artifacts | GitHub Actions webhook |
| Cost data | OpenRouter API + Claude Max usage | API polling |
| Environment health | Docker API | Health check polling |
| Communication | OpenClaw session logs | File watch on `~/.openclaw/agents/main/sessions/` |

---

## Part 7: Onboarding — Web-Based Wizard

Onboarding is a **6-step web wizard** inside Lyra Control — not a CLI script. Each step is a Server Action with real-time progress via SSE.

### Step 1: Project Information (Form)

Collects:
- **Project name**: Display name (e.g., "HelloWorld")
- **Local path**: Where the code lives (e.g., `~/nas/code/helloworld`)
- **Jira key**: Short key for Jira project (e.g., `HELLO`)
- **Tech stack**: Language/framework (e.g., "Node.js + Express + TypeScript")
- **Description**: One-line description for GitHub and Jira

Validation: Path exists, Jira key is unique, name is valid.

### Step 2: GitHub Setup

Server Action performs:
1. `gh repo create michaelbaker-dev/<name> --private`
2. Set branch protection rules on `main` and `develop`
3. Push initial code if repo is empty
4. Show: repo URL, branch protection status

### Step 3: Jira Project Setup

Server Action performs:
1. Create Jira project via REST API
2. Create custom fields (Agent Team, Agent Status, Worktree Branch, Cost)
3. Configure workflow (Backlog → To Do → In Progress → Code Review → QA → QA Passed → Done)
4. Set up automation rules (webhooks on transitions)
5. Show: project URL, custom field IDs, workflow status

### Step 4: File Scaffolding

Server Action generates from Handlebars templates:
1. `CLAUDE.md` — Project-specific Claude Code instructions
2. `.github/workflows/ci.yml` — CI pipeline
3. `.github/workflows/auto-merge.yml` — Auto-merge on CI pass
4. `.github/workflows/rollback.yml` — Post-merge smoke test + rollback
5. `.github/pull_request_template.md` — PR template with Jira link
6. `.gitignore` — If missing
7. Commits and pushes all generated files

### Step 5: OpenClaw Configuration

Server Action performs:
1. Register project channel binding (iMessage/Teams channel → project)
2. Configure cron jobs (dispatcher, QA runner, status reporter, stale checker)
3. Update Lyra's knowledge of the project
4. Show: cron schedule, channel bindings

### Step 6: Validation

Server Action performs:
1. Create test Jira ticket ("Validation: Hello World endpoint")
2. Verify dispatcher picks it up
3. Verify agent spawns and runs
4. Verify PR is created
5. Verify CI runs
6. Clean up test artifacts
7. Show: full cycle results, pass/fail per step

### Progress UI

Each step shows:
- Step indicator (1/6, 2/6, etc.)
- Current step status (pending, running, completed, failed)
- Real-time logs streamed via SSE
- Retry button on failure
- Skip button for optional steps

---

## Part 8: What You Might Be Missing

### From Good Engineering Practices

1. **The 17x Error Trap** (DeepMind research): Unstructured multi-agent networks amplify errors by 17.2x. Solution: Lyra as centralized orchestrator is correct. Never let agents coordinate peer-to-peer without oversight.

2. **Conflict resolution across parallel agents**: When 3 dev agents work on different features simultaneously, merge conflicts will happen. Use **Clash** (git worktree conflict detection tool) to detect conflicts before merge attempts. Strategy: merge one branch at a time, rebase others automatically.

3. **Audit trail**: Every agent action must be logged. Git commits with ticket IDs, Jira comments with agent logs, Claude Code session transcripts stored. The management app surfaces all of this.

4. **Secret management**: Agents need API keys and credentials. Never pass these through Jira or chat. Use `.env` files excluded from git. The management app stores keys encrypted.

5. **Test data isolation**: QA environment must have its own test data. Never let QA agents run against production databases. Docker Compose profiles enforce this.

6. **Rate limit awareness**: Claude Code Max has a 5-hour rolling window (~900 messages). The dispatcher must track remaining capacity and queue work accordingly rather than spawning agents that immediately hit limits.

7. **Rollback safety**: Auto-revert must be a clean `git revert` creating a new commit, not a `git reset --hard`. History is preserved, and the revert itself can be reverted if needed.

8. **The 45% Saturation Point**: Agent coordination yields highest returns when single-agent performance is low. As Claude Code improves, simpler setups (fewer agents, bigger tasks) may outperform complex multi-agent topologies. Build for simplicity first, add complexity only when measured.

9. **Cost monitoring is non-negotiable**: Without the management app tracking cost per ticket, costs can silently spiral. A retry loop on a flaky test can burn hundreds of messages. Set circuit breakers (max 5 retries per ticket before human alert).

10. **Progressive trust**: Start with human review of the first 10-20 PRs from each agent type. Once confidence is established in the auto-merge-rollback-fix cycle, remove the human gate. The management app should track this confidence score over time.

### Architecture Patterns Worth Adopting

11. **BMAD Method**: The most mature PRD-to-code AI workflow (12 specialized agent personas). Study it for the Architect agent's behavior. Port available for Claude Code at `github.com/24601/BMAD-AT-CLAUDE`.

12. **Anthropic's long-running agent pattern**: Use `claude-progress.txt` in each worktree for session continuity. Fresh sessions read this file to understand work state instantly.

13. **Feature flags**: Consider merging all agent code behind feature flags. Deployments are instant (merge to main), but feature activation is controlled separately. LaunchDarkly, FeatBit, or Unleash. Rollback becomes a flag toggle (milliseconds) instead of a revert (minutes).

---

## Part 9: Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Rate limit exhaustion (Claude Max) | High | Agents stall | Dispatcher tracks remaining budget, queues work |
| Merge conflicts between parallel agents | High | Wasted work | Clash detection, sequential merge strategy |
| Agent produces incorrect code | Medium | Bugs in main | QA agent + auto-rollback + feature flags |
| OpenClaw security vulnerability exploited | Low (local only) | System compromise | Keep local, no ClawHub installs, monitor |
| Jira API rate limits hit | Low | Delayed status updates | Batch Jira operations, cache queries |
| Runaway retry loops | Medium | Cost spike, wasted tokens | Circuit breaker: max 5 retries, then alert |
| Stale worktrees accumulate | Medium | Disk space | Cleanup cron: delete merged worktrees after 24h |

---

## Part 10: Implementation Order

| Phase | What | Dependencies |
|---|---|---|
| **1** | Build Lyra Control web app + onboarding wizard | — |
| **2** | Build custom Jira skill for OpenClaw | Jira API token |
| **3** | Build work dispatcher service (Jira → Claude Code in worktrees) | Phase 1, 2 |
| **4** | Build QA runner (Cucumber + Playwright automation) | Phase 3 |
| **5** | Build auto-merge-rollback pipeline (GitHub Actions) | Phase 3 |
| **6** | Onboard helloworld as first validation project | Phase 1-5 |
| **7** | Add DORA metrics collection and dashboards | Phase 6 (needs real data) |
| **8** | Add multi-model routing configuration | Phase 1 |
| **9** | Build Architect agent (PRD/ARD → Jira breakdown) | Phase 6 |
| **10** | Onboard AgentDog as second project | Phase 6 |

> **Note**: Onboarding and the management app are Phase 1 — not Phase 7. The management app IS the onboarding tool. Build it first, then use it to onboard everything else.

---

## Part 11: Key Technical Decisions Summary

| Decision | Choice | Why |
|---|---|---|
| Communication layer | OpenClaw (Lyra as Scrum Master) | Already working, has messaging + cron + identity |
| Development engine | Claude Code (Max subscription) | Superior code understanding, iterative debugging, headless CLI |
| Work tracking | Jira (mbakers.atlassian.net) | Your requirement, industry standard, rich API |
| Project routing | Dedicated channels per project | Your preference, clean separation |
| Merge strategy | Auto-merge → test → rollback → fix → retry | Your requirement, fully autonomous |
| Jira project creation | Via web-based onboarding wizard | Replaces CLI script — more reliable, visual progress |
| Model routing | Claude Max for agents, OpenRouter/auto for Lyra, local for classification | Cost-optimized, capability-matched |
| Management app | Custom-built (Next.js 15 + SQLite + DuckDB) | Nothing off-the-shelf covers AI agent management + DORA + model config |
| Database | SQLite (relational) + DuckDB (analytics) | Zero infrastructure, embedded, sufficient for single-user local app |
| Agent autonomy | `--dangerously-skip-permissions` | Full autonomy for unattended operation |
| Concurrent agents | 3-4 max | Research + rate limit constraints |
| Testing stack | Vitest + Cucumber + Playwright | Covers unit/API/E2E |
| Environment isolation | Docker Compose profiles (dev/qa/prod) | Already used by AgentDog |
| Dispatcher | TypeScript service (not shell scripts) | Integrated logging, SSE streaming, rate limit tracking |

---

## Part 12: Dogfooding Strategy — Use Lyra to Build Lyra

### The Chicken-and-Egg Problem

Lyra Control needs to exist before it can manage projects. But we want to use Lyra to build Lyra Control. Solution: **bootstrap manually, then switch to self-hosting**.

### Bootstrap Phase (Manual)

Build just enough to become self-hosting:

1. **Manually create** GitHub repo `michaelbaker-dev/lyra-control`
2. **Manually create** Jira project `LYRA` at mbakers.atlassian.net
3. **Manually build** the foundation: Next.js app, Prisma schema, layout, core libraries
4. **Manually build** the onboarding wizard (minimum viable)
5. **Manually build** the dispatcher service (minimum viable)
6. Once the dispatcher works → **Lyra is self-hosting**

### Self-Hosting Phase (Lyra Builds Lyra)

Once the dispatcher is operational:

1. Create Jira epics and stories for remaining Lyra Control features
2. Dispatcher assigns tickets to Claude Code agents
3. Agents implement features, create PRs
4. CI validates, auto-merges
5. Repeat until Lyra Control is complete

### What This Proves

- The onboarding wizard actually works end-to-end
- The dispatcher correctly polls Jira and spawns agents
- Claude Code can implement real features autonomously
- CI/CD pipeline catches issues before merge
- DORA metrics populate from real development activity
- Any workflow bugs are caught immediately (we're the customer)

### First Validation: helloworld

After Lyra Control is self-hosting, validate with `~/nas/code/helloworld`:

1. Walk through the onboarding wizard
2. Create `HELLO-1`: "Build Express server with GET /hello endpoint"
3. Verify: agent implements → PR → CI → auto-merge → DORA metrics populate
4. This proves the system works for external projects, not just itself

---

## Appendix: Sources

### OpenClaw
- OpenClaw GitHub: github.com/openclaw/openclaw (190K+ stars)
- Security: The Register "dumpster fire" (Feb 2026), Kaspersky "unsafe for use"
- Agent Teams RFC: github.com/openclaw/openclaw/discussions/10036
- Antfarm (community multi-agent): github.com/snarktank/antfarm
- Jira skill: github.com/openclaw/skills/blob/main/skills/jdrhyne/jira/SKILL.md — **DO NOT INSTALL** (ClawHub security risk)

### AI Development Patterns
- DeepMind 17x Error Trap: towardsdatascience.com (multi-agent error amplification)
- Anthropic long-running agents: anthropic.com/engineering/effective-harnesses-for-long-running-agents
- BMAD Method: github.com/bmad-code-org/BMAD-METHOD
- BMAD for Claude Code: github.com/24601/BMAD-AT-CLAUDE
- Anthropic 2026 Agentic Coding Trends Report

### Claude Code
- Headless operation: code.claude.com/docs/en/headless
- Max subscription limits: ~900 messages per 5-hour window, weekly compute caps
- Agent teams: 3-4 concurrent sweet spot

### DORA Metrics
- 2025 DORA State of AI-Assisted Software Development (Google Cloud)
- DORA evolved to 5 metrics (CD Foundation, 2025)
- AI agent metrics: cost per resolution, success rate, retry count, auto-merge rate

### Auto-Merge & Rollback
- Aviator MergeQueue: aviator.co/merge-queue
- Feature flags: LaunchDarkly, FeatBit, Unleash
- Clash (worktree conflict detection): github.com/clash-sh/clash

### Testing
- Playwright MCP: github.com/executeautomation/mcp-playwright
- Hybrid AI + BDD with Cucumber: levi9-serbia.medium.com
- AI QA Engineer with Claude Code + Playwright: alexop.dev

### Jira API
- REST API v3: developer.atlassian.com/cloud/jira/platform/rest/v3/
- Automation webhooks: developer.atlassian.com/cloud/jira/service-desk/automation-webhooks/
