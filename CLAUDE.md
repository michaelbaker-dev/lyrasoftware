# Lyra AI-Driven Development Platform

## What This Project Is

This directory contains the design documents and implementation for **Lyra**, an AI-driven development platform that coordinates autonomous AI agent teams across the full software development lifecycle. Lyra runs on OpenClaw for communication and scheduling, uses Claude Code for development execution, and tracks all work through Jira.

**Lyra Control** is the web-based command center (in `lyra-control/`) for managing the entire system.

## Directory Structure

```
~/code/aiSoftware/
├── AI-software.md          # Master design document
├── PRD.md                  # Product Requirements Document for Lyra Control
├── ARD.md                  # Architecture Decision Record
├── CLAUDE.md               # This file — Claude Code project instructions
├── .gitignore              # Git ignore rules
└── lyra-control/           # Next.js 15 web application
    ├── src/
    │   ├── app/            # App Router pages (onboarding, dashboard, metrics, settings)
    │   ├── lib/            # Core libraries (jira, github, openrouter, dispatcher, sse)
    │   ├── components/     # Shared UI components
    │   └── templates/      # Handlebars templates (CLAUDE.md, CI workflows, PR template)
    ├── prisma/
    │   └── schema.prisma   # SQLite database schema
    └── package.json
```

## Agile Roles

| Role | Who | Responsibility |
|---|---|---|
| Product Owner | Mike | Sets priorities, reviews metrics, onboards projects |
| Scrum Master | Lyra (OpenClaw) | Sprint management, routing, reporting, Jira automation |
| Architect Agent | Claude Code (Opus) | PRD/ARD generation, Jira epic/story breakdown |
| Dev Team | Claude Code (Sonnet) | Feature implementation, bug fixes, code review |
| QA Team | Claude Code (Sonnet) | Test generation, execution, pass/fail reporting |

## Coding Conventions

- **Language**: TypeScript (strict mode, ESM modules)
- **Framework**: Next.js 15 with App Router, Server Components, Server Actions
- **Styling**: Tailwind CSS
- **ORM**: Prisma with SQLite
- **Analytics**: DuckDB (queries SQLite via sqlitescanner)
- **Commits**: Conventional commits (`feat:`, `fix:`, `chore:`, `docs:`)
- **Formatting**: Prettier + ESLint
- **Testing**: Vitest (unit), Playwright (E2E)

## Database Architecture

- **SQLite** (via Prisma): Relational data — projects, agents, sessions, audit logs, settings
- **DuckDB**: Analytics — DORA metrics, cost aggregations, time-series queries
- DuckDB queries SQLite directly via the `sqlitescanner` extension (no ETL needed)
- Single-user local app — no need for PostgreSQL's concurrency features

## Related Systems

| System | Location | Purpose |
|---|---|---|
| OpenClaw | `~/.openclaw/` | Lyra identity, messaging, cron scheduling |
| Mission Control | OpenClaw built-in | Prototype builder/QA/release crons (reference only) |
| Templates | `lyra-control/src/templates/` | Handlebars templates for project scaffolding |

## AI Model Usage

| Task Type | Model | Route |
|---|---|---|
| Code implementation | Claude Sonnet 4.5 | Claude Code (Max subscription) |
| Architecture/PRD/ARD | Claude Opus 4 | Claude Code (Max subscription) |
| Simple fixes | Claude Haiku 4.5 | Claude Code or OpenRouter |
| Lyra chat, task routing | OpenRouter/auto | OpenRouter API |
| Classification | Local models (LM Studio) | 192.168.56.203:1234 |

**Rule**: Use OpenRouter/auto for all non-coding AI tasks to preserve Claude Max token budget for actual coding.

## Agent Autonomy

Agents run headlessly with full permissions:
```bash
claude -p "<prompt>" \
  --dangerously-skip-permissions \
  --output-format stream-json
```

Do NOT use `--allowedTools` — use `--dangerously-skip-permissions` for full autonomy.

## How to Run

```bash
cd lyra-control && npm run dev
# App runs at http://localhost:3000
```

## Dev Server Rules

- **NEVER run `npx next build` while the dev server is running.** It overwrites `.next/` and breaks all static asset URLs, causing the page to render without CSS/JS. The dev server does its own incremental compilation — a separate build is unnecessary during development.
- **Only one Next.js process at a time.** Before starting a dev server, kill any existing `next` processes: `pkill -9 -f "next-server"; pkill -9 -f "next dev"`
- If the page appears unstyled or broken: kill all next processes, `rm -rf .next`, restart with `npx next dev -p 3000`

## External Services

| Service | URL/Config |
|---|---|
| Jira | mbakers.atlassian.net (project: LYRA) |
| GitHub | github.com/michaelbaker-dev |
| OpenRouter | openrouter.ai (API key in settings) |
| Claude Max | Max subscription (~900 msgs / 5hr window) |
| OpenClaw | Local instance with Lyra identity |
