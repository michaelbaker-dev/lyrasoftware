/**
 * Dispatcher service — polls Jira for "To Do" tickets and spawns agents.
 * Supports two execution paths:
 *   1. Claude CLI — for Claude models (sonnet/opus/haiku) via Max subscription
 *   2. OpenRouter Agent — for non-Claude models (e.g. DeepSeek) via OpenRouter API
 * Runs as an in-process TypeScript service within the Next.js process.
 */

import { spawn, type ChildProcess } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";
import { searchIssues, transitionIssue, addComment, getIssue, getTransitions, extractDependencies } from "./jira";
import { createPR, enableAutoMerge } from "./github";
import { prisma } from "./db";
import { updateSprintProgress } from "./sprint-planner";
import { STORY_DOD } from "./dod";
import { lyraEvents } from "./lyra-events";
import { runQualityGate } from "./quality-gate";
import { getResolvedModel, resolveClaudeModel } from "./team-templates";
import { decide } from "./lyra-brain";
import { parseClaudeCodeOutput, trackUsage } from "./cost-tracker";
import { runOpenRouterAgent } from "./openrouter-agent";

const exec = promisify(execFile);

export interface DispatcherState {
  running: boolean;
  activeAgents: Map<string, AgentProcess>;
  pollInterval: number; // ms
  maxConcurrent: number;
  maxRetries: number;
  messagesUsed: number;
  messageLimit: number;
  timer: ReturnType<typeof setInterval> | null;
  _polling: boolean;
}

interface AgentProcess {
  ticketKey: string;
  projectKey: string;
  projectId: string;
  worktreePath: string;
  branch: string;
  process: ChildProcess | null; // null for OpenRouter agents
  abortController?: AbortController; // for OpenRouter agents
  startedAt: Date;
  retryCount: number;
  sessionId: string;
  output: string[];
}

// Persist state across Next.js HMR reloads (same pattern as Prisma singleton)
const globalForDispatcher = globalThis as unknown as {
  __dispatcherState: DispatcherState | undefined;
};

const state: DispatcherState = globalForDispatcher.__dispatcherState ?? {
  running: false,
  activeAgents: new Map(),
  pollInterval: 5 * 60 * 1000,
  maxConcurrent: 8,
  maxRetries: 5,
  messagesUsed: 0,
  messageLimit: 900,
  timer: null,
  _polling: false,
};

if (process.env.NODE_ENV !== "production") {
  globalForDispatcher.__dispatcherState = state;
}

// Track already-notified abandoned tickets to avoid spam on every poll cycle
const notifiedAbandoned = new Set<string>();

export function getState(): Omit<DispatcherState, "timer" | "activeAgents" | "_polling"> & {
  activeAgentCount: number;
  agents: {
    ticketKey: string;
    projectKey: string;
    startedAt: Date;
    branch: string;
    sessionId: string;
    outputTail: string;
  }[];
} {
  return {
    running: state.running,
    pollInterval: state.pollInterval,
    maxConcurrent: state.maxConcurrent,
    maxRetries: state.maxRetries,
    messagesUsed: state.messagesUsed,
    messageLimit: state.messageLimit,
    activeAgentCount: state.activeAgents.size,
    agents: Array.from(state.activeAgents.values()).map((a) => ({
      ticketKey: a.ticketKey,
      projectKey: a.projectKey,
      startedAt: a.startedAt,
      branch: a.branch,
      sessionId: a.sessionId,
      outputTail: a.output.join("").slice(-500),
    })),
  };
}

export async function start() {
  if (state.running) return;

  // Load config from database
  await loadConfig();

  // Clear dedup set on restart so abandoned tickets are re-evaluated
  notifiedAbandoned.clear();

  state.running = true;
  console.log("[Dispatcher] Started — polling every", state.pollInterval / 1000, "seconds");
  await pollAndDispatch();
  state.timer = setInterval(pollAndDispatch, state.pollInterval);
}

export function stop() {
  state.running = false;
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  console.log("[Dispatcher] Stopped");
}

/** Trigger an immediate dispatch cycle (debounced — safe to call rapidly). */
export function triggerDispatch() {
  if (!state.running || state._polling) return;
  console.log("[Dispatcher] Reactive trigger — checking for new work");
  pollAndDispatch();
}

async function loadConfig() {
  const settings = await prisma.setting.findMany({
    where: {
      key: {
        in: [
          "dispatcher_poll_interval",
          "dispatcher_max_agents",
          "dispatcher_max_retries",
        ],
      },
    },
  });

  for (const s of settings) {
    const val = parseInt(s.value, 10);
    if (isNaN(val)) continue;
    switch (s.key) {
      case "dispatcher_poll_interval":
        state.pollInterval = val * 60 * 1000; // stored as minutes
        break;
      case "dispatcher_max_agents":
        state.maxConcurrent = val;
        break;
      case "dispatcher_max_retries":
        state.maxRetries = val;
        break;
    }
  }
}

// ── Agent health monitor — kills stuck agents ──────────────────────

const MAX_AGENT_RUNTIME_MS = 2 * 60 * 60 * 1000; // 2 hours

async function monitorAgents() {
  const now = Date.now();
  for (const [ticketKey, agent] of state.activeAgents) {
    const elapsed = now - agent.startedAt.getTime();
    if (elapsed > MAX_AGENT_RUNTIME_MS) {
      console.warn(
        `[Dispatcher] Agent for ${ticketKey} exceeded ${MAX_AGENT_RUNTIME_MS / 60_000}min — killing`
      );

      // Save output to session before killing so failure context is available for retry
      try {
        await prisma.session.update({
          where: { id: agent.sessionId },
          data: { output: agent.output.join("") },
        });
      } catch {
        // Non-fatal
      }

      lyraEvents.emit("notify", {
        projectId: agent.projectId,
        severity: "warning",
        title: `Agent killed: ${ticketKey}`,
        body: `Agent running for ${Math.round(elapsed / 60_000)} minutes — terminated for exceeding time limit.`,
      });

      // Kill based on agent type
      if (agent.process) {
        // Claude CLI agent — SIGTERM first, SIGKILL after 10s
        agent.process.kill("SIGTERM");
        setTimeout(() => {
          try {
            agent.process?.kill("SIGKILL");
          } catch {
            // Already dead
          }
        }, 10_000);
      } else if (agent.abortController) {
        // OpenRouter agent — abort the signal
        agent.abortController.abort();
      }
    }
  }
}

async function pollAndDispatch() {
  if (!state.running) return;
  if (state._polling) return;
  state._polling = true;

  console.log(`[Dispatcher] Polling… (${state.activeAgents.size}/${state.maxConcurrent} agents active)`);

  // Check agent health before polling for new work
  await monitorAgents();

  if (state.activeAgents.size >= state.maxConcurrent) {
    console.log("[Dispatcher] At max concurrency, skipping poll");
    state._polling = false;
    return;
  }

  try {
    // Find all projects to poll
    const projects = await prisma.project.findMany({
      where: { status: "active" },
    });

    for (const project of projects) {
      if (state.activeAgents.size >= state.maxConcurrent) break;

      // Only work sprint tickets — never pull from backlog without an active sprint.
      // Stories must be planned into a sprint and the sprint explicitly started by the user.
      if (!project.activeSprintId) {
        console.log(`[Dispatcher] ${project.jiraKey}: No active sprint — skipping`);
        continue;
      }

      const sprintJql = `project = ${project.jiraKey} AND sprint = ${project.activeSprintId} AND status = "To Do" ORDER BY rank ASC`;
      const sprintResults = await searchIssues(sprintJql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tickets: Array<{ id: string; key: string; fields: Record<string, any> }> = sprintResults.issues || [];

      console.log(`[Dispatcher] ${project.jiraKey}: found ${tickets.length} "To Do" ticket(s) in sprint ${project.activeSprintId}`);

      for (const ticket of tickets) {
        if (state.activeAgents.size >= state.maxConcurrent) break;
        if (state.activeAgents.has(ticket.key)) continue;

        // Check blocking dependencies — skip if any blocker isn't dev-complete
        const DEV_COMPLETE_STATUSES = ["code review", "qa passed", "done"];
        const deps = extractDependencies(ticket);
        const blockers = deps.filter((d) => {
          if (d.type !== "is-blocked-by") return false;
          if (d.status === "done") return false;
          // Dev work is complete once in Code Review or QA Passed — don't block dependents
          if (DEV_COMPLETE_STATUSES.includes(d.statusName.toLowerCase())) return false;
          return true;
        });
        if (blockers.length > 0) {
          console.log(
            `[Dispatcher] Skipping ${ticket.key} — blocked by: ${blockers.map((b) => b.key).join(", ")}`
          );
          continue;
        }

        // Check retry count — skip tickets that have failed too many times
        // Count both session failures AND quality gate failures
        const failedSessions = await prisma.session.count({
          where: { ticketKey: ticket.key, projectId: project.id, status: "failed" },
        });
        const gateFailures = await prisma.qualityGateRun.count({
          where: { ticketKey: ticket.key, projectId: project.id, passed: false },
        });
        const failedAttempts = failedSessions + gateFailures;
        if (failedAttempts >= state.maxRetries) {
          if (!notifiedAbandoned.has(ticket.key)) {
            notifiedAbandoned.add(ticket.key);
            console.log(
              `[Dispatcher] ${ticket.key} has failed ${failedAttempts} times (max ${state.maxRetries}), skipping`
            );
            lyraEvents.emit("notify", {
              projectId: project.id,
              severity: "critical",
              title: `Ticket abandoned: ${ticket.key}`,
              body: `Failed ${failedAttempts} times — requires manual intervention.`,
            });

            // Cascade: find and notify dependents blocked by this abandoned ticket
            try {
              await handleAbandonedTicketCascade(ticket.key, project.id, project.jiraKey);
            } catch (e) {
              console.error(`[Dispatcher] Abandon cascade failed for ${ticket.key}:`, e);
            }
          }
          continue;
        }

        // Route ticket to team
        const ticketLabels = (ticket.fields.labels || []) as string[];
        const ticketComponents = ((ticket.fields.components || []) as { name: string }[]).map(
          (c: { name: string }) => c.name
        );
        const routedTeam = await routeTicketToTeam(project.id, {
          labels: ticketLabels,
          components: ticketComponents,
          summary: ticket.fields.summary,
        });

        await spawnAgent(
          ticket.key,
          project.jiraKey,
          project.id,
          project.path,
          ticket.fields.summary,
          ticket.fields.description,
          (project as { baseBranch?: string }).baseBranch || "main",
          routedTeam
        );
      }
    }
  } catch (error) {
    console.error("[Dispatcher] Poll error:", error);
    await prisma.auditLog.create({
      data: {
        action: "dispatcher.poll_error",
        actor: "dispatcher",
        details: JSON.stringify({ error: String(error) }),
      },
    });
  } finally {
    state._polling = false;
  }
}

// ── ADF → Plain Text helper ──────────────────────────────────────────

function adfToPlainText(node: unknown): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (typeof node !== "object") return "";
  const n = node as Record<string, unknown>;
  if (n.type === "text" && typeof n.text === "string") {
    const marks = n.marks as Array<{ type: string }> | undefined;
    const isBold = marks?.some((m) => m.type === "strong");
    return isBold ? `**${n.text}**` : n.text;
  }
  if (Array.isArray(n.content)) {
    const parts = (n.content as unknown[]).map((child) => adfToPlainText(child));
    const blockTypes = ["paragraph", "heading", "bulletList", "orderedList", "listItem", "codeBlock"];
    if (typeof n.type === "string" && blockTypes.includes(n.type)) return parts.join("") + "\n";
    return parts.join("");
  }
  return "";
}

// Extract assigned role from Jira description (ADF or plain text)
// Uses cached role names from RoleConfig for dynamic matching
let _cachedRoleRegex: RegExp | null = null;
let _cachedRoleNames: string[] | null = null;
let _roleRegexExpiry = 0;

async function getExtractRoleRegex(): Promise<{ regex: RegExp; roleNames: string[] }> {
  if (_cachedRoleRegex && _cachedRoleNames && Date.now() < _roleRegexExpiry) {
    return { regex: _cachedRoleRegex, roleNames: _cachedRoleNames };
  }
  const { getRoleNames } = await import("./role-config");
  const roleNames = await getRoleNames();
  const pattern = roleNames.join("|");
  _cachedRoleRegex = new RegExp(`\\*\\*Assigned Role\\*\\*:\\s*(${pattern})`, "i");
  _cachedRoleNames = roleNames;
  _roleRegexExpiry = Date.now() + 60_000;
  return { regex: _cachedRoleRegex, roleNames };
}

async function extractRole(description: unknown): Promise<string> {
  if (!description) return "dev";

  const text = typeof description === "string" ? description : adfToPlainText(description);

  const { regex } = await getExtractRoleRegex();
  const match = text.match(regex);
  return match?.[1]?.toLowerCase() || "dev";
}

// Extract acceptance criteria from Jira description (ADF or plain text)
function extractAcceptanceCriteria(description: unknown): string[] {
  if (!description) return [];

  const text = typeof description === "string" ? description : adfToPlainText(description);

  const criteria: string[] = [];
  const lines = text.split("\n");
  let inCriteria = false;

  for (const line of lines) {
    if (/\*\*Acceptance Criteria:?\*\*/.test(line) || /^Acceptance Criteria:?\s*$/i.test(line.trim())) {
      inCriteria = true;
      continue;
    }
    if (inCriteria) {
      const match = line.match(/^[-*]\s*(?:\[[ x]?\]\s*)?(.+)/);
      if (match) {
        criteria.push(match[1].trim());
      } else if (line.match(/^\*\*/) || (line.trim() === "" && criteria.length > 0)) {
        // Hit next section header or blank line after criteria — stop
        if (line.match(/^\*\*/)) break;
      }
    }
  }

  return criteria;
}

// Role-specific system prompts — loaded from RoleConfig table (see role-config.ts)

// ── Team-aware ticket routing ────────────────────────────────────────

type TicketInfo = {
  labels?: string[];
  components?: string[];
  summary?: string;
};

async function routeTicketToTeam(
  projectId: string,
  ticket: TicketInfo
): Promise<{ id: string; name: string; specialization: string; model: string; systemPrompt: string | null } | null> {
  const teams = await prisma.team.findMany({
    where: { projectId, enabled: true },
    orderBy: { routingPriority: "asc" },
  });

  if (teams.length === 0) return null;

  const ticketLabels = (ticket.labels || []).map((l) => l.toLowerCase());
  const ticketComponents = (ticket.components || []).map((c) => c.toLowerCase());
  const allTicketTags = [...ticketLabels, ...ticketComponents];

  // Tier 1: Label/component match
  for (const team of teams) {
    if (!team.routingLabels) continue;
    const routingLabels: string[] = JSON.parse(team.routingLabels);
    if (routingLabels.length === 0) continue;

    const hasMatch = routingLabels.some((rl) =>
      allTicketTags.some((tt) => tt.includes(rl.toLowerCase()) || rl.toLowerCase().includes(tt))
    );

    if (hasMatch) {
      return team;
    }
  }

  // Tier 2: AI classification
  if (ticket.summary) {
    try {
      const teamDescriptions = teams
        .map((t) => `- ${t.name} (${t.specialization}): routes labels = ${t.routingLabels || "[]"}`)
        .join("\n");

      const decision = await decide({
        projectId,
        event: "ticket_routing",
        question: `Which team should handle this ticket? Pick the best team name from the list.`,
        data: {
          ticketSummary: ticket.summary,
          ticketLabels: allTicketTags,
          availableTeams: teamDescriptions,
        },
      });

      if (decision.details.teamName && typeof decision.details.teamName === "string") {
        const matched = teams.find(
          (t) => t.name.toLowerCase() === (decision.details.teamName as string).toLowerCase()
        );
        if (matched) return matched;
      }
    } catch {
      // AI classification failed — fall through to default
    }
  }

  // Tier 3: Default fallback
  const defaultTeam = teams.find((t) => t.isDefault);
  return defaultTeam || teams[0];
}

// ── Abandon Cascade ───────────────────────────────────────────────────

async function handleAbandonedTicketCascade(
  abandonedKey: string,
  projectId: string,
  projectKey: string
) {
  // Find all "To Do" tickets in the project that are blocked by the abandoned ticket
  const jql = `project = ${projectKey} AND status = "To Do" ORDER BY rank ASC`;
  const results = await searchIssues(jql, 100);

  const blockedByAbandoned: string[] = [];

  for (const issue of results.issues || []) {
    const deps = extractDependencies(issue);
    const isBlockedByAbandoned = deps.some(
      (d) => d.type === "is-blocked-by" && d.key === abandonedKey
    );
    if (isBlockedByAbandoned) {
      blockedByAbandoned.push(issue.key);
    }
  }

  if (blockedByAbandoned.length === 0) return;

  console.warn(
    `[Dispatcher] Abandoned ${abandonedKey} blocks ${blockedByAbandoned.length} tickets: ${blockedByAbandoned.join(", ")}`
  );

  // Comment on each blocked ticket so agents and humans know
  for (const blockedKey of blockedByAbandoned) {
    await addComment(
      blockedKey,
      `[LYRA] Blocker ${abandonedKey} has been abandoned (max retries exceeded). ` +
      `This ticket cannot proceed until ${abandonedKey} is resolved manually or its blocking link is removed.`
    ).catch(() => {});
  }

  // Emit critical notification for dashboard visibility
  lyraEvents.emit("notify", {
    projectId,
    severity: "critical",
    title: `Abandoned blocker: ${abandonedKey}`,
    body: `${abandonedKey} was abandoned and blocks: ${blockedByAbandoned.join(", ")}. These tickets need manual intervention.`,
  });

  // Emit typed event for downstream listeners
  lyraEvents.emit("ticket:abandoned", {
    ticketKey: abandonedKey,
    projectId,
    blockedTickets: blockedByAbandoned,
  });
}

// ── Shared Completion Handler ─────────────────────────────────────────

interface CompletionContext {
  session: { id: string };
  agent: { id: string; name: string; team?: { id: string } | null } | null;
  ticketKey: string;
  projectKey: string;
  projectId: string;
  worktreePath: string;
  branchName: string;
  baseBranch: string;
  summary: string;
  acceptanceCriteria: string[];
  assignedRole: string;
  retryCount: number;
}

interface CompletionCostData {
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  provider: string;
  requestedModel: string;
  actualModel: string;
}

async function handleAgentCompletion(
  exitCode: number,
  rawOutput: string,
  ctx: CompletionContext,
  costData: CompletionCostData
) {
  state.activeAgents.delete(ctx.ticketKey);

  // Auto-commit safety net: catch uncommitted work before declaring success
  let finalOutput = rawOutput;
  if (exitCode === 0) {
    try {
      const { stdout: statusOut } = await exec("git", ["status", "--porcelain"], { cwd: ctx.worktreePath });
      if (statusOut.trim()) {
        console.warn(`[Dispatcher] ${ctx.ticketKey}: auto-committing uncommitted changes:\n${statusOut.trim()}`);
        await exec("git", ["add", "-A"], { cwd: ctx.worktreePath });
        await exec("git", ["commit", "-m", `feat(${ctx.ticketKey}): ${ctx.summary} (auto-commit)`], { cwd: ctx.worktreePath });
        finalOutput += "\n[Lyra] Auto-committed uncommitted changes.";
      } else {
        // Diagnostic: check if branch has ANY commits beyond base
        try {
          const { stdout: logOut } = await exec("git", ["log", `${ctx.baseBranch}..HEAD`, "--oneline"], { cwd: ctx.worktreePath });
          if (!logOut.trim()) {
            console.log(`[Dispatcher] ${ctx.ticketKey}: No commits on branch — will check if AC already met`);
          }
        } catch { /* non-fatal diagnostic */ }
      }
    } catch (e) {
      console.error(`[Dispatcher] Auto-commit failed for ${ctx.ticketKey}:`, e);
    }
  }

  const status = exitCode === 0 ? "completed" : "failed";

  // Update session with cost data
  await prisma.session.update({
    where: { id: ctx.session.id },
    data: {
      status,
      completedAt: new Date(),
      output: finalOutput,
      cost: costData.cost,
      tokensUsed: costData.totalTokens,
    },
  });

  // Track usage in AiUsageLog
  if (costData.totalTokens > 0 || costData.cost > 0) {
    try {
      await trackUsage({
        projectId: ctx.projectId,
        sessionId: ctx.session.id,
        agentId: ctx.agent?.id,
        teamId: ctx.agent?.team?.id,
        category: "agent_run",
        ticketKey: ctx.ticketKey,
        provider: costData.provider,
        requestedModel: costData.requestedModel,
        actualModel: costData.actualModel,
        promptTokens: costData.promptTokens,
        completionTokens: costData.completionTokens,
        totalTokens: costData.totalTokens,
        cost: costData.cost,
        durationMs: Date.now() - (state.activeAgents.get(ctx.ticketKey)?.startedAt.getTime() ?? Date.now()),
      });
    } catch (e) {
      console.error("[Dispatcher] Cost tracking failed (non-fatal):", e);
    }
  }

  // Update agent
  if (ctx.agent) {
    await prisma.agent.update({
      where: { id: ctx.agent.id },
      data: { status: "idle", currentTicket: null, startedAt: null },
    });
  }

  if (exitCode === 0) {
    // Emit agent:completed — quality gate will evaluate the work
    lyraEvents.emit("agent:completed", {
      ticketKey: ctx.ticketKey,
      projectId: ctx.projectId,
      sessionId: ctx.session.id,
      agentName: ctx.agent?.name || "unknown",
      branch: ctx.branchName,
      worktreePath: ctx.worktreePath,
      summary: ctx.summary,
      exitCode,
    });

    // Run quality gate
    const gateResult = await runQualityGate({
      sessionId: ctx.session.id,
      ticketKey: ctx.ticketKey,
      projectId: ctx.projectId,
      worktreePath: ctx.worktreePath,
      baseBranch: ctx.baseBranch,
      acceptanceCriteria: ctx.acceptanceCriteria,
      agentOutput: finalOutput,
      summary: ctx.summary,
    });

    // "Already done" path — AC met with zero code changes, skip PR
    if (gateResult.passed && gateResult.alreadyDone) {
      const gateComment = [
        "h3. Quality Gate — PASSED (already done)",
        "Agent confirmed acceptance criteria are already met by existing code. No PR needed.",
        "",
        ...gateResult.checks.map(
          (c) => `* ${c.passed ? "(/)" : "(x)"} ${c.name}: ${c.details.slice(0, 200)}`
        ),
        "",
        `Lyra: ${gateResult.reasoning}`,
      ].join("\n");
      await addComment(ctx.ticketKey, gateComment).catch(() => {});

      // Transition directly to Done — no Code Review needed since no code changed
      await transitionToStatus(ctx.ticketKey, "Done");

      lyraEvents.emit("ticket:already-done", {
        ticketKey: ctx.ticketKey,
        projectId: ctx.projectId,
        sessionId: ctx.session.id,
        reasoning: gateResult.reasoning,
      });

      return; // Skip PR creation entirely
    }

    if (gateResult.passed) {
      // Gate passed — rebase onto latest base, push branch, create PR
      try {
        // Rebase onto latest base branch to prevent merge conflicts
        try {
          await exec("git", ["fetch", "origin", ctx.baseBranch], { cwd: ctx.worktreePath });
          await exec("git", ["rebase", `origin/${ctx.baseBranch}`], { cwd: ctx.worktreePath });
        } catch (rebaseErr) {
          // Rebase conflict — abort and push as-is (PR will show conflicts)
          console.warn(`[Dispatcher] Rebase failed for ${ctx.ticketKey}, pushing without rebase:`, rebaseErr);
          await exec("git", ["rebase", "--abort"], { cwd: ctx.worktreePath }).catch(() => {});
        }

        await exec("git", ["push", "-u", "origin", ctx.branchName, "--force-with-lease"], {
          cwd: ctx.worktreePath,
        });

        const project = await prisma.project.findUnique({ where: { id: ctx.projectId } });
        const repoName = project?.githubRepo || "";
        const prBase = (project as { baseBranch?: string } | null)?.baseBranch || "main";

        if (repoName) {
          const prUrl = await createPR(
            repoName,
            `${ctx.ticketKey}: ${ctx.summary}`,
            `## Summary\n\nImplements ${ctx.ticketKey}: ${ctx.summary}\n\nJira: https://mbakers.atlassian.net/browse/${ctx.ticketKey}`,
            ctx.branchName,
            prBase,
            ctx.projectId
          );
          await addComment(ctx.ticketKey, `PR created: ${prUrl}`);

          // Enable auto-merge (squash) so PR merges once CI passes
          const prMatch = prUrl.match(/\/pull\/(\d+)/);
          if (prMatch) {
            await enableAutoMerge(repoName, parseInt(prMatch[1]), ctx.projectId).catch((e) =>
              console.error(`[Dispatcher] Auto-merge failed for ${ctx.ticketKey}:`, e)
            );
          }

          lyraEvents.emit("pr:created", {
            ticketKey: ctx.ticketKey,
            projectId: ctx.projectId,
            prUrl,
            branch: ctx.branchName,
          });
        }
      } catch (e) {
        console.error(`[Dispatcher] Push/PR failed for ${ctx.ticketKey}:`, e);
        await addComment(ctx.ticketKey, `Agent completed but push/PR failed: ${e}`).catch(() => {});
      }

      // Post quality gate results and transition — ALWAYS runs even if push/PR failed
      const gateComment = [
        "h3. Quality Gate — PASSED",
        ...gateResult.checks.map(
          (c) => `* ${c.passed ? "(/)" : "(x)"} ${c.name}: ${c.details.slice(0, 200)}`
        ),
        "",
        `Lyra: ${gateResult.reasoning}`,
      ].join("\n");
      await addComment(ctx.ticketKey, gateComment).catch(() => {});

      // Transition to Code Review for QA — fall back to Done for simple Jira workflows
      const transitioned = await transitionToStatus(ctx.ticketKey, "Code Review");
      if (!transitioned) {
        console.log(`[Dispatcher] No "Code Review" status for ${ctx.ticketKey} — transitioning to Done`);
        await transitionToStatus(ctx.ticketKey, "Done");
      }
    } else {
      // Gate failed — send back to To Do with failure explanation
      await addComment(
        ctx.ticketKey,
        [
          "h3. Quality Gate — FAILED (sent back for rework)",
          "",
          `Reasoning: ${gateResult.reasoning}`,
          "",
          "Failed checks:",
          ...gateResult.checks
            .filter((c) => !c.passed)
            .map((c) => `* (x) ${c.name}: ${c.details.slice(0, 300)}`),
        ].join("\n")
      );
      await transitionToStatus(ctx.ticketKey, "To Do");

      lyraEvents.emit("notify", {
        projectId: ctx.projectId,
        severity: "warning",
        title: `Quality gate failed: ${ctx.ticketKey}`,
        body: gateResult.reasoning,
      });

      // Run failure triage on quality gate failures (non-fatal)
      try {
        const { triageAndActOnFailure } = await import("./failure-analyzer");
        const teams = await prisma.team.findMany({
          where: { projectId: ctx.projectId, enabled: true },
          select: { name: true },
        });
        const failedSessions = await prisma.session.count({
          where: { ticketKey: ctx.ticketKey, projectId: ctx.projectId, status: "failed" },
        });
        const gateFailureCount = await prisma.qualityGateRun.count({
          where: { ticketKey: ctx.ticketKey, projectId: ctx.projectId, passed: false },
        });

        await triageAndActOnFailure({
          projectId: ctx.projectId,
          ticketKey: ctx.ticketKey,
          ticketSummary: ctx.summary,
          sessionId: ctx.session.id,
          sessionOutput: finalOutput,
          gateDetails: gateResult.checks
            .filter((c: { passed: boolean }) => !c.passed)
            .map((c: { name: string; passed: boolean; details: string }) => `FAILED: ${c.name} — ${c.details}`)
            .join("\n"),
          attemptCount: failedSessions + gateFailureCount,
          teamLabels: teams.map((t) => t.name),
          source: "quality_gate",
        });
      } catch (e) {
        console.error(`[Dispatcher] Gate failure triage error (non-fatal) for ${ctx.ticketKey}:`, e);
      }
    }
  } else {
    // Agent failed
    lyraEvents.emit("agent:failed", {
      ticketKey: ctx.ticketKey,
      projectId: ctx.projectId,
      sessionId: ctx.session.id,
      agentName: ctx.agent?.name || "unknown",
      exitCode: exitCode || 1,
      error: `Agent exited with code ${exitCode}`,
    });

    await addComment(ctx.ticketKey, `Agent exited with code ${exitCode}. Returning to To Do for retry.`);
    await transitionToStatus(ctx.ticketKey, "To Do");

    // Run failure triage (non-fatal)
    try {
      const { triageAndActOnFailure } = await import("./failure-analyzer");

      // Gather team labels for routing
      const teams = await prisma.team.findMany({
        where: { projectId: ctx.projectId, enabled: true },
        select: { name: true },
      });

      // Count total failures (sessions + gate failures)
      const failedSessions = await prisma.session.count({
        where: { ticketKey: ctx.ticketKey, projectId: ctx.projectId, status: "failed" },
      });
      const gateFailures = await prisma.qualityGateRun.count({
        where: { ticketKey: ctx.ticketKey, projectId: ctx.projectId, passed: false },
      });

      await triageAndActOnFailure({
        projectId: ctx.projectId,
        ticketKey: ctx.ticketKey,
        ticketSummary: ctx.summary,
        sessionId: ctx.session.id,
        sessionOutput: finalOutput,
        attemptCount: failedSessions + gateFailures,
        teamLabels: teams.map((t) => t.name),
      });
    } catch (e) {
      console.error(`[Dispatcher] Failure triage error (non-fatal) for ${ctx.ticketKey}:`, e);
    }
  }

  // Update sprint progress if agent completed successfully
  if (exitCode === 0) {
    try {
      await updateSprintProgress(ctx.projectId);
    } catch {
      // Non-fatal
    }
  }

  await prisma.auditLog.create({
    data: {
      projectId: ctx.projectId,
      action: `agent.${status}`,
      actor: ctx.agent?.name || "dispatcher",
      details: JSON.stringify({ ticketKey: ctx.ticketKey, code: exitCode, role: ctx.assignedRole }),
    },
  });

  // Reactively trigger next dispatch — pick up new work within seconds
  // Use 3s delay to ensure Jira transitions have settled, then retry at 10s as safety net
  setTimeout(() => triggerDispatch(), 3000);
  setTimeout(() => triggerDispatch(), 10000);
}

// ── Spawn Agent ───────────────────────────────────────────────────────

async function spawnAgent(
  ticketKey: string,
  projectKey: string,
  projectId: string,
  projectPath: string,
  summary: string,
  description?: unknown,
  baseBranch: string = "main",
  team?: { id: string; name: string; specialization: string; model: string; systemPrompt: string | null } | null,
  promptOverride?: string
) {
  // Create worktree
  const branchType = ticketKey.toLowerCase().includes("bug") ? "fix" : "feat";
  const branchName = `${branchType}/${ticketKey}-${summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)}`;
  const worktreeDir = join(projectPath, "worktrees");
  const worktreePath = join(worktreeDir, `dev-${ticketKey}`);

  try {
    mkdirSync(worktreeDir, { recursive: true });

    // Clean up stale worktree if it exists from a previous run
    if (existsSync(worktreePath)) {
      await exec("git", ["worktree", "remove", "--force", worktreePath], {
        cwd: projectPath,
      }).catch(() => {}); // May fail if already gone
    }

    // Delete stale local branch if it exists (won't fail if absent)
    await exec("git", ["branch", "-D", branchName], {
      cwd: projectPath,
    }).catch(() => {});

    // Fetch latest from remote before branching
    await exec("git", ["fetch", "origin", baseBranch], {
      cwd: projectPath,
    }).catch(() => {});

    // Create git worktree branching from the project's base branch
    await exec("git", ["worktree", "add", worktreePath, "-b", branchName, baseBranch], {
      cwd: projectPath,
    });
  } catch (error) {
    console.error(`[Dispatcher] Failed to create worktree for ${ticketKey}:`, error);
    return;
  }

  // Extract role and acceptance criteria from ticket description
  const assignedRole = await extractRole(description);
  const acceptanceCriteria = extractAcceptanceCriteria(description);

  // Find an available agent matching the role (team-scoped if routed)
  const agent = await prisma.agent.findFirst({
    where: {
      projectId,
      role: assignedRole,
      status: "idle",
      ...(team ? { teamId: team.id } : {}),
    },
    include: { team: true },
  }) ?? (team ? await prisma.agent.findFirst({
    where: { projectId, role: assignedRole, status: "idle" },
    include: { team: true },
  }) : null);

  if (!agent) {
    console.log(
      `[Dispatcher] No idle ${assignedRole} agent available for ${ticketKey} (team: ${team?.name ?? "any"}) — skipping`
    );
    lyraEvents.emit("notify", {
      projectId,
      severity: "warning",
      title: `No ${assignedRole} agent available`,
      body: `${ticketKey} requires a ${assignedRole} agent but none are idle. Add one in Team Config.`,
    });
    return;
  }

  // Create session record
  const session = await prisma.session.create({
    data: {
      agentId: agent.id,
      projectId,
      ticketKey,
      branch: branchName,
      worktreePath,
      status: "running",
    },
  });

  // Update agent status
  if (agent) {
    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: "running", currentTicket: ticketKey, startedAt: new Date() },
    });
  }

  const { getRolePrompt } = await import("./role-config");
  const rolePrompt = await getRolePrompt(assignedRole);

  // Build failure context from previous attempts (Phase 2: cuts retry failures)
  let failureContext = "";
  try {
    const prevFailures = await prisma.session.findMany({
      where: { ticketKey, projectId, status: "failed" },
      orderBy: { completedAt: "desc" },
      take: 2,
      select: { output: true, completedAt: true },
    });
    const gateFailures = await prisma.qualityGateRun.findMany({
      where: { ticketKey, projectId, passed: false },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { checks: true, reasoning: true },
    });

    if (prevFailures.length > 0 || gateFailures.length > 0) {
      const parts: string[] = ["\n## Previous Failures (DO NOT repeat these mistakes)"];

      for (const f of prevFailures) {
        const tail = (f.output || "").slice(-2000);
        if (tail) {
          parts.push(`### Failed session (${f.completedAt?.toISOString() ?? "unknown"})`, "```", tail, "```");
        }
      }

      for (const g of gateFailures) {
        parts.push(`### Quality gate failure: ${g.reasoning}`);
        try {
          const checks = JSON.parse(g.checks) as { name: string; passed: boolean; details: string }[];
          for (const c of checks.filter((c) => !c.passed)) {
            parts.push(`- FAILED: ${c.name} — ${c.details.slice(0, 300)}`);
          }
        } catch { /* invalid JSON */ }
      }

      parts.push("", "Address the specific failures above. Do NOT repeat the same mistakes.");
      failureContext = parts.join("\n");
    }
  } catch (e) {
    console.error("[Dispatcher] Failed to load failure context (non-fatal):", e);
  }

  // Check for PO instructions in Jira comments
  let poInstructions = "";
  try {
    const issue = await getIssue(ticketKey);
    const comments = issue?.fields?.comment?.comments || [];
    // Find the most recent [PO INSTRUCTIONS] comment
    for (let i = comments.length - 1; i >= 0; i--) {
      const commentBody = typeof comments[i].body === "string"
        ? comments[i].body
        : JSON.stringify(comments[i].body || "");
      if (commentBody.includes("[PO INSTRUCTIONS]")) {
        // Extract the instructions text (everything after [PO INSTRUCTIONS] up to first newline)
        const match = commentBody.match(/\[PO INSTRUCTIONS\]\s*(.+?)(?:\n|$)/);
        if (match) {
          poInstructions = `\n## Product Owner Instructions\n${match[1].trim()}\n\nFollow these instructions carefully — they come directly from the Product Owner.\n`;
        }
        break;
      }
    }
  } catch (e) {
    console.error("[Dispatcher] Failed to fetch PO instructions (non-fatal):", e);
  }

  // Phase 3: Session continuity via claude-progress.txt
  let progressContext = "";
  const progressFile = join(worktreePath, "claude-progress.txt");
  try {
    if (existsSync(progressFile)) {
      const progress = readFileSync(progressFile, "utf-8").slice(-3000);
      progressContext = `\n## Previous Session Progress\n${progress}\nContinue from where the previous session left off.\n`;
      console.log(`[Dispatcher] Found claude-progress.txt for ${ticketKey} — injecting context`);
    }
  } catch {
    // Non-fatal — progress file read failed
  }

  const progressInstruction = `
## Session Continuity
Maintain a file called \`claude-progress.txt\` in the repository root.
Update it after each major step with:
- What has been completed
- What remains to be done
- Current approach and any blockers
- Key decisions made
This file helps the next session resume if this one is interrupted.
`;

  // Build acceptance criteria section
  const acSection = acceptanceCriteria.length > 0
    ? `\n## Acceptance Criteria\n${acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n")}\n`
    : "";

  // Build Definition of Done section
  const dodSection = `\n## Definition of Done (MUST satisfy ALL before finishing)\n${STORY_DOD.map((d) => `- [ ] ${d}`).join("\n")}\n`;

  // Build codebase context from analysis
  let codebaseContext = "";
  const projectData = await prisma.project.findUnique({
    where: { id: projectId },
    select: { codebaseAnalysis: true },
  });
  if (projectData?.codebaseAnalysis) {
    try {
      const analysis = JSON.parse(projectData.codebaseAnalysis);
      codebaseContext = `\n## Codebase Context
- Framework: ${analysis.framework}
- Language: ${analysis.language}
- Package Manager: ${analysis.packageManager}
- Key Dependencies: ${(analysis.keyDependencies || []).join(", ")}
- Test Framework: ${analysis.testFramework || "None"}
${analysis.testPattern ? `- Test Pattern: ${analysis.testPattern}` : ""}
- Entry Points: ${(analysis.entryPoints || []).join(", ")}

### Directory Layout
${analysis.directoryOverview || "Not available"}
`;
    } catch {
      // Invalid JSON — skip
    }
  }

  // Layered prompt: team systemPrompt → role prompt → agent personality → codebase → ticket
  const teamPromptSection = (team?.systemPrompt || agent?.team?.systemPrompt)
    ? `${team?.systemPrompt || agent?.team?.systemPrompt}\n\n`
    : "";
  const personalitySection = agent?.personality
    ? `\nPersonality: ${agent.personality}\n`
    : "";

  // Convert ADF description to plain text for prompt injection
  const descriptionText = description ? (typeof description === "string" ? description : adfToPlainText(description)) : "";
  const descriptionSection = descriptionText
    ? `\n## Story Description\n${descriptionText}\n`
    : "";

  const scopeGuardrail = `\n## Scope\nYou are working on ONLY this ticket: ${ticketKey}. Do NOT create project scaffolding (package.json, tsconfig.json, directory structures) unless this ticket specifically requires it. If a file you need doesn't exist and isn't part of your ticket, note it as a dependency.\n`;

  const prompt = promptOverride ?? `${teamPromptSection}${rolePrompt}${personalitySection}${codebaseContext}${progressContext}

Ticket: ${ticketKey}: ${summary}
${descriptionSection}${acSection}${scopeGuardrail}${failureContext}${poInstructions}${dodSection}${progressInstruction}
Commit with the ticket ID in the message (e.g., "feat(${ticketKey}): description").

Do NOT finish until all acceptance criteria AND Definition of Done items are satisfied.`;

  // Save prompt to session record
  await prisma.session.update({
    where: { id: session.id },
    data: { prompt },
  });

  // Resolve model via global tier system (attempt-based escalation)
  const prevFailedSessions = await prisma.session.count({
    where: { ticketKey, projectId, status: "failed" },
  });
  const prevGateFailures = await prisma.qualityGateRun.count({
    where: { ticketKey, projectId, passed: false },
  });
  const attemptCount = prevFailedSessions + prevGateFailures;

  const { resolveModelTier, loadTierConfig } = await import("./team-templates");
  const tierConfig = await loadTierConfig();
  const tier = resolveModelTier(attemptCount, false, tierConfig);
  const resolvedModel = tier.model;
  console.log(`[Dispatcher] ${ticketKey}: ${tier.reason} (tier ${tier.tier}, attempt ${attemptCount})`);

  const resolved = resolveClaudeModel(resolvedModel);

  // Fill in LM Studio URL for local models
  if (resolved.envOverrides?.ANTHROPIC_BASE_URL === "") {
    const lmUrlSetting = await prisma.setting.findUnique({ where: { key: "lm_studio_url" } });
    resolved.envOverrides.ANTHROPIC_BASE_URL = lmUrlSetting?.value || "http://192.168.56.203:1234";
  }

  const { model: claudeModel, isNative } = resolved;

  // Build shared completion context
  const completionCtx: CompletionContext = {
    session,
    agent,
    ticketKey,
    projectKey,
    projectId,
    worktreePath,
    branchName,
    baseBranch,
    summary,
    acceptanceCriteria,
    assignedRole,
    retryCount: 0,
  };

  // Transition Jira to In Progress
  try {
    const { transitions } = await import("./jira").then((m) => m.getTransitions(ticketKey));
    const inProgress = transitions?.find(
      (t: { name: string }) =>
        t.name.toLowerCase().includes("progress") || t.name.toLowerCase().includes("in progress")
    );
    if (inProgress) {
      await transitionIssue(ticketKey, inProgress.id);
    }
    await addComment(
      ticketKey,
      `Agent ${agent?.name || "dev"} started working. Branch: ${branchName}. Model: ${resolvedModel}${isNative ? " (Claude CLI)" : " (OpenRouter)"}`
    );
  } catch {
    // Non-fatal — continue even if Jira update fails
  }

  await prisma.auditLog.create({
    data: {
      projectId,
      action: "agent.started",
      actor: agent?.name || "dispatcher",
      details: JSON.stringify({ ticketKey, branch: branchName, model: resolvedModel, execution: isNative ? "claude-cli" : "openrouter" }),
    },
  });

  if (isNative) {
    // ── Claude CLI execution path ───────────────────────────────────
    spawnClaudeCliAgent(prompt, claudeModel, worktreePath, completionCtx, resolvedModel, resolved.envOverrides);
  } else {
    // ── OpenRouter execution path ───────────────────────────────────
    console.log(`[Dispatcher] Using OpenRouter for ${ticketKey} with model: ${resolvedModel}`);
    spawnOpenRouterAgentInProcess(resolvedModel, prompt, completionCtx);
  }
}

// ── Claude CLI Agent Spawn ────────────────────────────────────────────

function spawnClaudeCliAgent(
  prompt: string,
  claudeModel: string,
  worktreePath: string,
  ctx: CompletionContext,
  resolvedModel: string,
  envOverrides?: Record<string, string>
) {
  // Strip CLAUDECODE env var so spawned agents don't think they're nested sessions
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  // Inject env overrides (e.g. ANTHROPIC_BASE_URL for LM Studio local models)
  if (envOverrides) {
    Object.assign(cleanEnv, envOverrides);
  }

  const child = spawn(
    "claude",
    ["-p", prompt, "--model", claudeModel, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
    {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv,
    }
  );

  const agentProcess: AgentProcess = {
    ticketKey: ctx.ticketKey,
    projectKey: ctx.projectKey,
    projectId: ctx.projectId,
    worktreePath,
    branch: ctx.branchName,
    process: child,
    startedAt: new Date(),
    retryCount: 0,
    sessionId: ctx.session.id,
    output: [],
  };

  state.activeAgents.set(ctx.ticketKey, agentProcess);

  // Log spawn errors
  child.on("error", (err) => {
    console.error(`[Dispatcher] Spawn error for ${ctx.ticketKey}:`, err);
  });

  // Debounced agent:output emit (flush every 2s)
  let outputBuffer = "";
  let outputTimer: ReturnType<typeof setTimeout> | null = null;
  const flushOutput = () => {
    if (outputBuffer) {
      lyraEvents.emit("agent:output", {
        ticketKey: ctx.ticketKey,
        projectId: ctx.projectId,
        sessionId: ctx.session.id,
        line: outputBuffer,
        timestamp: new Date().toISOString(),
      });
      outputBuffer = "";
    }
    outputTimer = null;
  };

  // Collect output
  child.stdout?.on("data", (data: Buffer) => {
    agentProcess.output.push(data.toString());
    outputBuffer += data.toString();
    if (!outputTimer) outputTimer = setTimeout(flushOutput, 2000);
  });
  child.stderr?.on("data", (data: Buffer) => {
    console.error(`[Dispatcher] ${ctx.ticketKey} stderr:`, data.toString().slice(0, 200));
    agentProcess.output.push(data.toString());
    outputBuffer += data.toString();
    if (!outputTimer) outputTimer = setTimeout(flushOutput, 2000);
  });

  // Handle completion
  child.on("close", async (code) => {
    if (outputTimer) clearTimeout(outputTimer);
    flushOutput();
    const rawOutput = agentProcess.output.join("");
    const parsedCost = parseClaudeCodeOutput(rawOutput);

    await handleAgentCompletion(code ?? 1, rawOutput, ctx, {
      cost: parsedCost.cost,
      promptTokens: parsedCost.promptTokens,
      completionTokens: parsedCost.completionTokens,
      totalTokens: parsedCost.totalTokens,
      provider: "claude-max",
      requestedModel: resolvedModel,
      actualModel: claudeModel,
    });
  });
}

// ── OpenRouter Agent Spawn (in-process) ───────────────────────────────

async function spawnOpenRouterAgentInProcess(
  resolvedModel: string,
  prompt: string,
  ctx: CompletionContext
) {
  const abortController = new AbortController();

  const agentProcess: AgentProcess = {
    ticketKey: ctx.ticketKey,
    projectKey: ctx.projectKey,
    projectId: ctx.projectId,
    worktreePath: ctx.worktreePath,
    branch: ctx.branchName,
    process: null,
    abortController,
    startedAt: new Date(),
    retryCount: 0,
    sessionId: ctx.session.id,
    output: [],
  };

  state.activeAgents.set(ctx.ticketKey, agentProcess);

  try {
    const result = await runOpenRouterAgent({
      model: resolvedModel,
      prompt,
      worktreePath: ctx.worktreePath,
      projectId: ctx.projectId,
      sessionId: ctx.session.id,
      agentId: ctx.agent?.id,
      teamId: ctx.agent?.team?.id,
      ticketKey: ctx.ticketKey,
      abortSignal: abortController.signal,
    });

    await handleAgentCompletion(result.exitCode, result.output, ctx, {
      cost: result.cost,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      provider: "openrouter",
      requestedModel: resolvedModel,
      actualModel: resolvedModel,
    });
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[Dispatcher] OpenRouter agent error for ${ctx.ticketKey}:`, errorMsg);

    await handleAgentCompletion(1, `OpenRouter agent error: ${errorMsg}`, ctx, {
      cost: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      provider: "openrouter",
      requestedModel: resolvedModel,
      actualModel: resolvedModel,
    });
  }
}

// ── Helper: transition ticket to a named status ─────────────────────

export async function transitionToStatus(
  ticketKey: string,
  targetStatus: string
): Promise<boolean> {
  try {
    const { transitions } = await getTransitions(ticketKey);
    const target = transitions?.find(
      (t: { name: string }) =>
        t.name.toLowerCase() === targetStatus.toLowerCase() ||
        t.name.toLowerCase().includes(targetStatus.toLowerCase())
    );
    if (!target) {
      console.warn(`[Dispatcher] No transition matching "${targetStatus}" for ${ticketKey}`);
      return false;
    }
    await transitionIssue(ticketKey, target.id);
    return true;
  } catch (e) {
    console.error(`[Dispatcher] Transition error for ${ticketKey}:`, e);
    return false;
  }
}

/** Retry a ticket with an optional custom prompt override. */
export async function retryTicket(
  ticketKey: string,
  projectId: string,
  customPrompt?: string
): Promise<{ sessionId: string }> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error(`Project ${projectId} not found`);

  // Fetch ticket from Jira
  const issue = await getIssue(ticketKey);
  if (!issue) throw new Error(`Jira ticket ${ticketKey} not found`);

  const summary: string = issue.fields?.summary ?? ticketKey;
  const description: unknown = issue.fields?.description;

  // Route to team
  const ticketLabels = (issue.fields?.labels || []) as string[];
  const ticketComponents = ((issue.fields?.components || []) as { name: string }[]).map(
    (c: { name: string }) => c.name
  );
  const routedTeam = await routeTicketToTeam(projectId, {
    labels: ticketLabels,
    components: ticketComponents,
    summary,
  });

  // Transition back to To Do if needed
  await transitionToStatus(ticketKey, "To Do").catch(() => {});

  // Spawn agent — will create a new session
  await spawnAgent(
    ticketKey,
    project.jiraKey,
    projectId,
    project.path,
    summary,
    description,
    project.baseBranch || "main",
    routedTeam,
    customPrompt || undefined
  );

  // Find the most recently created session for this ticket
  const latestSession = await prisma.session.findFirst({
    where: { ticketKey, projectId },
    orderBy: { createdAt: "desc" },
  });

  if (!latestSession) throw new Error("Failed to create session");
  return { sessionId: latestSession.id };
}

export async function updateConfig(config: {
  pollInterval?: number;
  maxConcurrent?: number;
  maxRetries?: number;
}) {
  if (config.pollInterval) state.pollInterval = config.pollInterval;
  if (config.maxConcurrent) state.maxConcurrent = config.maxConcurrent;
  if (config.maxRetries) state.maxRetries = config.maxRetries;

  if (state.running && state.timer) {
    clearInterval(state.timer);
    state.timer = setInterval(pollAndDispatch, state.pollInterval);
  }
}
