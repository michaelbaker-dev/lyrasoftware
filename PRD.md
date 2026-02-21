# Lyra Control — Product Requirements Document

## 1. Problem Statement

- No implementation exists for the Lyra AI-driven development platform described in AI-software.md
- No centralized dashboard for monitoring AI agent teams
- No automated project onboarding workflow
- No DORA metrics tracking for AI-powered development
- Manual processes (shell scripts, CLI commands) are error-prone and don't scale
- No visibility into agent cost, performance, or health

## 2. Product Vision

Lyra Control is a web-based command center for managing autonomous AI development teams. It handles project onboarding, agent orchestration, real-time monitoring, DORA metrics, and cost tracking — all from one app.

The app runs locally on a Mac mini. It is the single pane of glass for the entire Lyra ecosystem: OpenClaw (communication), Claude Code (development), Jira (work tracking), and GitHub (code hosting).

## 3. Users & Personas

### Product Owner (Mike)
- Onboards new projects via web wizard
- Reviews DORA metrics and velocity trends
- Sets priorities and strategic direction
- Monitors cost and agent health
- Communicates with Lyra via iMessage/Teams/email

### Scrum Master (Lyra / OpenClaw)
- Automated sprint management and task routing
- Polls Jira for work, dispatches to agents
- Reports status via configured channels
- Manages rate limits and agent scheduling

### Dev/QA Agents (Claude Code)
- Consume work from Jira via dispatcher
- Report status back via Jira comments and PR creation
- Run in isolated git worktrees with full autonomy

## 4. Functional Requirements

### 4.1 Project Onboarding Wizard

| ID | Requirement | Details |
|---|---|---|
| FR-001 | Multi-step web form | Collects project name, local path, Jira key, tech stack, description |
| FR-002 | GitHub repo creation | Creates private repo in `michaelbaker-dev` org via `gh` CLI |
| FR-003 | Branch protection rules | Require CI passing, require PR review, no direct push to main/develop |
| FR-004 | Jira project creation | Creates project with custom fields (Agent Team, Agent Status, Worktree Branch, Cost) and workflow (Backlog → To Do → In Progress → Code Review → QA → QA Passed → Done) |
| FR-005 | Project file scaffolding | Generates CLAUDE.md, ci.yml, auto-merge.yml, rollback.yml, PR template, .gitignore from Handlebars templates |
| FR-006 | OpenClaw configuration | Registers project bindings, configures cron jobs (dispatcher, QA runner, status reporter, stale checker) |
| FR-007 | End-to-end validation | Creates test ticket, triggers dispatcher, verifies full cycle (ticket → agent → PR → CI → merge) |
| FR-008 | Real-time step progress | Shows 6-step progress bar with logs, retry/skip options per step |

### 4.2 Dashboard

| ID | Requirement | Details |
|---|---|---|
| FR-010 | Active agents panel | Shows each agent's project, current ticket, status (idle/running/errored/rate-limited), elapsed time |
| FR-011 | Work queue | Jira tickets across all projects grouped by status |
| FR-012 | Cost ticker | Today/week/month spend broken down by model and agent |
| FR-013 | Recent activity feed | Last 20 audit log entries (agent actions, merges, rollbacks) |
| FR-014 | System health | OpenClaw status, Claude Max budget remaining, Jira API health |

### 4.3 Project Management

| ID | Requirement | Details |
|---|---|---|
| FR-020 | Project list | All onboarded projects with health indicators (green/yellow/red) |
| FR-021 | Per-project sprint board | Kanban view of Jira tickets for selected project |
| FR-022 | Agent assignment view | Which agent is working on which ticket |
| FR-023 | Velocity chart | Story points completed per sprint |
| FR-024 | Environment status | Docker container health for dev/QA/prod |
| FR-025 | Recent PRs | Pull requests with CI status badges |

### 4.4 DORA Metrics

| ID | Requirement | Details |
|---|---|---|
| FR-030 | Deployment frequency | Merges per day and per week |
| FR-031 | Lead time for changes | Time from ticket creation to merge |
| FR-032 | Change failure rate | Percentage of merges requiring rollback |
| FR-033 | Failed deployment recovery time | Time from failure detection to successful fix |
| FR-034 | AI-specific metrics | Agent success rate, auto-merge rate, cost per ticket, tokens per story point, retry count, utilization |
| FR-035 | Filterable views | Filter by project, time range, agent type |
| FR-036 | Charts | Bar, line, and gauge charts powered by DuckDB analytics |

### 4.5 Dispatcher Service

| ID | Requirement | Details |
|---|---|---|
| FR-040 | Jira polling | TypeScript service polls Jira every 15 min for "To Do" tickets |
| FR-041 | Git worktree creation | Creates isolated worktree per ticket: `worktrees/{team}-{TICKET}` |
| FR-042 | Claude Code spawning | Runs `claude -p --dangerously-skip-permissions --output-format stream-json` |
| FR-043 | Real-time streaming | Agent output streamed to UI via Server-Sent Events |
| FR-044 | Jira status updates | Transitions ticket on start (In Progress), completion (Code Review), failure (back to To Do) |
| FR-045 | PR creation | Creates pull request via `gh pr create` with Jira ticket linking |
| FR-046 | Rate limit tracking | Tracks Claude Max budget (~900 msgs / 5hr window), queues when near limit |
| FR-047 | Circuit breaker | Max 5 retries per ticket, then creates alert and stops |
| FR-048 | Worktree cleanup | Removes merged worktrees after 24h TTL |
| FR-049 | Start/stop controls | UI can start, stop, and view status of dispatcher per project |

### 4.6 QA Runner Service

| ID | Requirement | Details |
|---|---|---|
| FR-050 | Jira polling for QA | Polls for tickets in "QA" status |
| FR-051 | Branch checkout | Checks out feature branch into QA worktree |
| FR-052 | Tiered test execution | Runs unit tests, API/Cucumber tests, E2E/Playwright tests |
| FR-053 | Test generation | Uses Claude Code to generate new tests for changed files |
| FR-054 | Result reporting | Reports pass/fail to Jira with logs as comments |
| FR-055 | Status transitions | Moves ticket to "QA Passed" or back to "To Do" with failure details |

### 4.7 Settings

| ID | Requirement | Details |
|---|---|---|
| FR-060 | API key management | Jira, OpenRouter API keys — masked display, rotatable |
| FR-061 | Model assignment | Set model per agent role with per-project overrides |
| FR-062 | Concurrency limits | Max parallel agents (default: 3-4) |
| FR-063 | Cron schedule config | Adjust dispatcher, QA runner, reporter intervals |
| FR-064 | Channel mappings | Map Teams/iMessage channels to projects |
| FR-065 | Notification preferences | What gets reported, via which channel, at what frequency |

## 5. Non-Functional Requirements

| ID | Requirement | Details |
|---|---|---|
| NFR-001 | Local deployment | Runs on Mac mini, no cloud infrastructure required |
| NFR-002 | SQLite for relational data | Zero infrastructure — no database server needed |
| NFR-003 | DuckDB for analytics | 10-100x faster than SQLite for time-series aggregations |
| NFR-004 | Real-time updates | Server-Sent Events for dashboard live updates |
| NFR-005 | Performance | < 1 second page load for dashboard |
| NFR-006 | Configuration | All config via environment variables or settings UI (no hardcoding) |

## 6. Technical Constraints

| Constraint | Details |
|---|---|
| Framework | Next.js 15 + TypeScript + Tailwind CSS |
| ORM | Prisma with SQLite |
| Analytics DB | DuckDB |
| Non-coding AI | OpenRouter/auto |
| Coding AI | Claude Code (Max subscription) |
| Code hosting | GitHub (michaelbaker-dev org) |
| Work tracking | Jira (mbakers.atlassian.net) |
| Communication | OpenClaw with Lyra identity |
| Template engine | Handlebars for project scaffolding |

## 7. Success Criteria

| ID | Criterion | Measurement |
|---|---|---|
| SC-001 | Onboard helloworld project in < 5 minutes via web wizard | Timed end-to-end wizard completion |
| SC-002 | Agent autonomously implements HELLO-1 ticket end-to-end | Ticket moves from To Do → Done without human intervention |
| SC-003 | CI runs and auto-merges PR | GitHub Actions passes, PR merged automatically |
| SC-004 | DORA metrics populate after first completed ticket | Metrics page shows deployment frequency and lead time |
| SC-005 | Dashboard shows real-time agent status during work | SSE updates reflect agent state changes within 5 seconds |

## 8. Out of Scope (v1)

- Multi-user authentication (single-user local app)
- Cloud deployment
- Mobile app
- Advanced RBAC / permissions
- Integration with project management tools other than Jira
- Custom workflow designer
