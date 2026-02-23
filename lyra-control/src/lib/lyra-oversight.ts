/**
 * Lyra Active Oversight — proactive sprint management.
 * Runs periodically to check idle capacity, stuck agents,
 * repeated failures, and overall sprint progress.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "./db";
import { getState, triggerDispatch, retryWithNewPlan } from "./dispatcher";
import { decide, remember, analyzeDeadlockedTicket } from "./lyra-brain";
import { lyraEvents, think } from "./lyra-events";
import { searchIssues, addComment, moveIssuesToSprint, rankIssues, createIssue, getIssue, extractDependencies } from "./jira";

const exec = promisify(execFile);

// ── Main entry point ────────────────────────────────────────────────

export async function runOversightCheck(): Promise<void> {
  console.log("[Oversight] Running Lyra oversight check…");
  think("oversight", "start", "Running oversight checks...");

  try {
    const projects = await prisma.project.findMany({
      where: { status: "active" },
    });

    for (const project of projects) {
      await checkIdleCapacity(project);
      await checkStuckAgents(project);
      await checkRepeatedFailures(project);
      await checkSprintProgress(project);
      await checkSprintCompletion(project);
      await checkDeadlock(project);
    }
  } catch (e) {
    console.error("[Oversight] Error during oversight check:", e);
  }

  think("oversight", "done", "Oversight checks complete");
}

// ── Check 1: Idle capacity with available work ──────────────────────

async function checkIdleCapacity(project: { id: string; jiraKey: string; activeSprintId: number | null }) {
  think("oversight", "check", "Checking idle capacity...", { projectId: project.id });
  const dispatcherState = getState();

  const idleAgentCount = await prisma.agent.count({
    where: { projectId: project.id, status: "idle" },
  });

  if (idleAgentCount === 0) return;

  // Check if there's "To Do" work available
  const jql = project.activeSprintId
    ? `project = ${project.jiraKey} AND sprint = ${project.activeSprintId} AND status = "To Do" ORDER BY rank ASC`
    : `project = ${project.jiraKey} AND status = "To Do" ORDER BY priority DESC, created ASC`;

  try {
    const results = await searchIssues(jql);
    const todoCount = results.issues?.length ?? 0;

    if (todoCount > 0 && idleAgentCount > 0) {
      think("oversight", "evaluating", `Found ${idleAgentCount} idle agents, ${todoCount} tickets waiting`, { projectId: project.id });
      console.log(
        `[Oversight] ${project.jiraKey}: ${idleAgentCount} idle agent(s) with ${todoCount} "To Do" ticket(s) — triggering dispatch`
      );

      await remember(project.id, "observation", {
        event: "idle_capacity_detected",
        idleAgents: idleAgentCount,
        todoTickets: todoCount,
        activeAgents: dispatcherState.activeAgentCount,
      });

      think("oversight", "acting", "Triggering dispatch for idle capacity", { projectId: project.id });
      triggerDispatch();
    }
  } catch (e) {
    console.error(`[Oversight] Idle capacity check failed for ${project.jiraKey}:`, e);
  }
}

// ── Check 2: Stuck agents (no git activity) ─────────────────────────

async function checkStuckAgents(project: { id: string; jiraKey: string }) {
  think("oversight", "check", "Checking for stuck agents...", { projectId: project.id });
  const runningAgents = await prisma.agent.findMany({
    where: { projectId: project.id, status: "running", startedAt: { not: null } },
    include: { sessions: { where: { status: "running" }, take: 1, orderBy: { startedAt: "desc" } } },
  });

  const now = Date.now();

  for (const agent of runningAgents) {
    if (!agent.startedAt) continue;
    const elapsed = now - agent.startedAt.getTime();
    const elapsedMin = Math.round(elapsed / 60_000);

    const session = agent.sessions[0];
    if (!session) continue;

    // Check for git activity in worktree
    let hasRecentCommits = true;
    try {
      const { stdout } = await exec("git", ["log", "--since=45 minutes ago", "--oneline"], {
        cwd: session.worktreePath,
        timeout: 5000,
      });
      hasRecentCommits = stdout.trim().length > 0;
    } catch {
      hasRecentCommits = false;
    }

    if (elapsed > 45 * 60_000 && !hasRecentCommits) {
      think("oversight", "evaluating", `Agent ${agent.name} stuck on ${agent.currentTicket} for ${elapsedMin}min`, { projectId: project.id, ticketKey: agent.currentTicket || undefined });
      const severity = elapsed > 90 * 60_000 ? "critical" : "warning";
      const title = elapsed > 90 * 60_000
        ? `Agent stuck (${elapsedMin}min): ${agent.currentTicket}`
        : `Agent slow (${elapsedMin}min): ${agent.currentTicket}`;

      lyraEvents.emit("notify", {
        projectId: project.id,
        severity,
        title,
        body: `Agent ${agent.name} working on ${agent.currentTicket} for ${elapsedMin} min with no git commits in 45+ min.`,
      });

      await remember(project.id, "observation", {
        event: "stuck_agent_detected",
        agentName: agent.name,
        ticketKey: agent.currentTicket,
        elapsedMinutes: elapsedMin,
        severity,
      });
    }
  }
}

// ── Check 3: Repeated failures ──────────────────────────────────────

async function checkRepeatedFailures(project: { id: string; jiraKey: string }) {
  think("oversight", "check", "Checking repeated failures...", { projectId: project.id });
  // Find tickets with 3+ failed sessions
  const failedGroups = await prisma.session.groupBy({
    by: ["ticketKey"],
    where: { projectId: project.id, status: "failed" },
    _count: { id: true },
    having: { id: { _count: { gte: 3 } } },
  });

  // Also find tickets with 3+ quality gate failures
  const gateFailedGroups = await prisma.qualityGateRun.groupBy({
    by: ["ticketKey"],
    where: { projectId: project.id, passed: false },
    _count: { id: true },
    having: { id: { _count: { gte: 3 } } },
  });

  // Merge into a map: ticketKey → max failure count from either source
  const mergedFailures = new Map<string, number>();
  for (const g of failedGroups) {
    mergedFailures.set(g.ticketKey, g._count.id);
  }
  for (const g of gateFailedGroups) {
    const existing = mergedFailures.get(g.ticketKey) ?? 0;
    mergedFailures.set(g.ticketKey, Math.max(existing, g._count.id));
  }

  for (const [ticketKey, failureCount] of mergedFailures) {
    // Alias for compatibility with the rest of the loop
    const group = { ticketKey, _count: { id: failureCount } };
    // Check if already escalated recently (avoid spam)
    const recentEscalation = await prisma.lyraMemory.findFirst({
      where: {
        projectId: project.id,
        category: "escalation",
        content: { contains: group.ticketKey },
        createdAt: { gte: new Date(Date.now() - 60 * 60_000) }, // within last hour
      },
    });

    if (recentEscalation) continue;

    try {
      think("oversight", "evaluating", `${group.ticketKey} failed ${group._count.id} times — consulting brain`, { projectId: project.id, ticketKey: group.ticketKey });

      const decision = await decide({
        projectId: project.id,
        event: "repeated_failures",
        ticketKey: group.ticketKey,
        question: `Ticket ${group.ticketKey} has failed ${group._count.id} times. What should we do? Options: escalate to human, split the ticket into smaller tasks, add more context to the prompt, or skip for now.`,
        data: {
          ticketKey: group.ticketKey,
          failureCount: group._count.id,
        },
      });

      await remember(project.id, "escalation", {
        event: "repeated_failure_decision",
        ticketKey: group.ticketKey,
        failureCount: group._count.id,
        action: decision.action,
        reasoning: decision.reasoning,
      });

      lyraEvents.emit("notify", {
        projectId: project.id,
        severity: "warning",
        title: `Repeated failures: ${group.ticketKey} (${group._count.id}x)`,
        body: `Lyra recommendation: ${decision.action}\n${decision.reasoning}`,
      });

      // Act on the decision
      try {
        const actionLower = decision.action.toLowerCase();

        if (actionLower.includes("escalate")) {
          const { triageAndActOnFailure } = await import("./failure-analyzer");
          await triageAndActOnFailure({
            projectId: project.id,
            ticketKey: group.ticketKey,
            ticketSummary: `Repeated failure (${group._count.id}x)`,
            attemptCount: group._count.id,
            forcedAction: "escalate",
            source: "oversight_escalation",
          });
        } else if (actionLower.includes("split")) {
          think("oversight", "acting", `Splitting ${group.ticketKey} into sub-tasks`, { projectId: project.id, ticketKey: group.ticketKey });

          // Ask brain to suggest 2-3 sub-task summaries
          let subtasksCreated = false;
          try {
            const splitDecision = await decide({
              projectId: project.id,
              event: "split_ticket",
              ticketKey: group.ticketKey,
              question: `Ticket ${group.ticketKey} has failed ${group._count.id} times and needs to be split. Suggest 2-3 smaller sub-task summaries that together accomplish the original goal.`,
              data: { ticketKey: group.ticketKey, failureCount: group._count.id },
            });

            const subtasks = splitDecision.details?.subtasks as string[] | undefined;
            if (subtasks && subtasks.length > 0) {
              for (const summary of subtasks.slice(0, 3)) {
                await createIssue(
                  project.jiraKey,
                  "Subtask",
                  summary,
                  `Sub-task of ${group.ticketKey}. Created by Lyra oversight after ${group._count.id} failures.`,
                  group.ticketKey
                );
              }

              await addComment(
                group.ticketKey,
                `[OVERSIGHT] Split into ${subtasks.length} sub-tasks after ${group._count.id} failures.\n\nSub-tasks:\n${subtasks.map((s) => `- ${s}`).join("\n")}`
              );

              subtasksCreated = true;
            }
          } catch (splitErr) {
            console.error(`[Oversight] Sub-task creation failed for ${group.ticketKey}:`, splitErr);
          }

          if (!subtasksCreated) {
            // Fallback: comment + block (original behavior)
            await addComment(
              group.ticketKey,
              `[OVERSIGHT] This story has failed ${group._count.id} times. Lyra recommends splitting it into smaller tasks.\n\nReasoning: ${decision.reasoning}`
            );
          }

          const { transitionToStatus } = await import("./dispatcher");
          await transitionToStatus(group.ticketKey, "Blocked").catch(() => {});
          triggerDispatch();
        } else if (actionLower.includes("context") || actionLower.includes("add")) {
          const { triageAndActOnFailure } = await import("./failure-analyzer");
          await triageAndActOnFailure({
            projectId: project.id,
            ticketKey: group.ticketKey,
            ticketSummary: `Needs more context (${group._count.id} failures)`,
            attemptCount: group._count.id,
            source: "oversight_context",
          });
        }
        // "continue" / "skip" → no additional action (current behavior)
      } catch (e) {
        console.error(`[Oversight] Failed to act on decision for ${group.ticketKey}:`, e);
      }
    } catch (e) {
      console.error(`[Oversight] Repeated failure check error for ${group.ticketKey}:`, e);
    }
  }
}

// ── Check 4: Sprint progress ────────────────────────────────────────

async function checkSprintProgress(project: { id: string; jiraKey: string; activeSprintId: number | null }) {
  think("oversight", "check", "Checking sprint progress...", { projectId: project.id });
  if (!project.activeSprintId) return;

  const sprint = await prisma.sprint.findFirst({
    where: { jiraSprintId: project.activeSprintId },
  });

  if (!sprint || !sprint.endDate) return;

  const now = new Date();
  const start = sprint.startDate ?? sprint.createdAt;
  const totalDays = Math.max(1, (sprint.endDate.getTime() - start.getTime()) / (24 * 60 * 60_000));
  const elapsedDays = (now.getTime() - start.getTime()) / (24 * 60 * 60_000);
  const timePercent = Math.round((elapsedDays / totalDays) * 100);
  const completionPercent = sprint.plannedPoints > 0
    ? Math.round((sprint.completedPoints / sprint.plannedPoints) * 100)
    : 0;

  // Behind by more than 20%: time elapsed > completion + 20%
  if (timePercent > completionPercent + 20 && timePercent > 30) {
    // Only report once per hour
    const recentReport = await prisma.lyraMemory.findFirst({
      where: {
        projectId: project.id,
        category: "observation",
        content: { contains: "sprint_risk" },
        createdAt: { gte: new Date(Date.now() - 60 * 60_000) },
      },
    });

    if (recentReport) return;

    think("oversight", "evaluating", `Sprint ${completionPercent}% done, ${timePercent}% time elapsed — risk detected`, { projectId: project.id });

    try {
      const decision = await decide({
        projectId: project.id,
        event: "sprint_risk",
        question: `Sprint is ${timePercent}% through but only ${completionPercent}% of points completed (${sprint.completedPoints}/${sprint.plannedPoints}). Assess the risk and suggest adjustments.`,
        data: {
          sprintName: sprint.name,
          timePercent,
          completionPercent,
          completedPoints: sprint.completedPoints,
          plannedPoints: sprint.plannedPoints,
          daysRemaining: Math.round(totalDays - elapsedDays),
        },
      });

      await remember(project.id, "observation", {
        event: "sprint_risk",
        timePercent,
        completionPercent,
        action: decision.action,
        reasoning: decision.reasoning,
      });

      lyraEvents.emit("notify", {
        projectId: project.id,
        severity: "warning",
        title: `Sprint at risk: ${completionPercent}% done, ${timePercent}% elapsed`,
        body: `${decision.reasoning}\n\nRecommendation: ${decision.action}`,
      });

      // Act on the sprint risk decision
      const actionLower = decision.action.toLowerCase();
      try {
        if (actionLower.includes("descope")) {
          think("oversight", "acting", "De-scoping lowest-priority tickets from sprint", { projectId: project.id });
          // Find lowest-priority To Do tickets and remove from sprint
          const todoJql = `project = ${project.jiraKey} AND sprint = ${project.activeSprintId} AND status = "To Do" ORDER BY rank DESC`;
          const todoResults = await searchIssues(todoJql, 3);
          const toRemove = todoResults.issues || [];
          for (const issue of toRemove.slice(0, 2)) {
            await addComment(issue.key, `[OVERSIGHT] De-scoped from sprint due to sprint risk. ${decision.reasoning}`);
          }
        } else if (actionLower.includes("capacity")) {
          think("oversight", "acting", "Temporarily increasing agent concurrency", { projectId: project.id });
          const { updateConfig } = await import("./dispatcher");
          const currentMax = getState().maxConcurrent;
          await updateConfig({ maxConcurrent: currentMax + 2 });
          // Schedule reset after 2h
          setTimeout(async () => {
            await updateConfig({ maxConcurrent: currentMax });
            console.log(`[Oversight] Reset maxConcurrent back to ${currentMax}`);
          }, 2 * 60 * 60_000);
        } else if (actionLower.includes("prioritize") || actionLower.includes("reorder")) {
          think("oversight", "acting", "Re-ranking top tickets by priority", { projectId: project.id });
          const topJql = `project = ${project.jiraKey} AND sprint = ${project.activeSprintId} AND status = "To Do" ORDER BY priority DESC`;
          const topResults = await searchIssues(topJql, 5);
          const topKeys = (topResults.issues || []).map((i) => i.key);
          if (topKeys.length > 1) {
            await rankIssues(topKeys);
          }
        }
        // "notify"/"monitor"/default → current behavior (notification only)
      } catch (actionErr) {
        console.error(`[Oversight] Sprint risk action failed for ${project.jiraKey}:`, actionErr);
      }
    } catch (e) {
      console.error(`[Oversight] Sprint progress check error for ${project.jiraKey}:`, e);
    }
  }
}

// ── Check 5: Sprint completion — pull from backlog when sprint work is done ──

async function checkSprintCompletion(project: { id: string; jiraKey: string; activeSprintId: number | null }) {
  if (!project.activeSprintId) return;

  think("oversight", "check", "Checking sprint completion...", { projectId: project.id });

  // Count "To Do" and "In Progress" tickets in the active sprint
  const todoJql = `project = ${project.jiraKey} AND sprint = ${project.activeSprintId} AND status in ("To Do", "In Progress") AND issuetype != Epic`;
  const todoResults = await searchIssues(todoJql, 1);
  const activeCount = todoResults.total;

  if (activeCount > 0) return; // Still work to do

  // Throttle: skip if backlog_pull memory exists within last hour
  const recentPull = await prisma.lyraMemory.findFirst({
    where: {
      projectId: project.id,
      category: "observation",
      content: { contains: "backlog_pull" },
      createdAt: { gte: new Date(Date.now() - 60 * 60_000) },
    },
  });

  if (recentPull) return;

  think("oversight", "evaluating", "All sprint work done — checking backlog", { projectId: project.id });

  // Query backlog: tickets not in any active sprint, status = "To Do"
  const backlogJql = `project = ${project.jiraKey} AND sprint is EMPTY AND status = "To Do" AND issuetype != Epic ORDER BY rank ASC`;
  try {
    const backlogResults = await searchIssues(backlogJql, 3);
    const backlogItems = backlogResults.issues || [];

    if (backlogItems.length > 0) {
      think("oversight", "acting", `Pulling ${backlogItems.length} items from backlog into sprint`, { projectId: project.id });

      const keys = backlogItems.map((i) => i.key);
      await moveIssuesToSprint(project.activeSprintId, keys);

      for (const issue of backlogItems) {
        await addComment(issue.key, `[OVERSIGHT] Pulled from backlog into active sprint — all previous sprint work is complete.`);
      }

      lyraEvents.emit("notify", {
        projectId: project.id,
        severity: "info",
        title: "Backlog items pulled into sprint",
        body: `All sprint work complete. Pulled ${keys.length} items: ${keys.join(", ")}`,
      });

      await remember(project.id, "observation", {
        event: "backlog_pull",
        pulledTickets: keys,
      });

      triggerDispatch();
    } else {
      think("oversight", "done", "Sprint complete, backlog empty", { projectId: project.id });

      await remember(project.id, "reflection", {
        type: "sprint_complete",
        message: "Sprint complete and backlog is empty. All planned work is done.",
      });
    }
  } catch (e) {
    console.error(`[Oversight] Sprint completion check error for ${project.jiraKey}:`, e);
  }
}

// ── Check 6: Deadlock detection — all tickets stuck ──────────────────

async function checkDeadlock(project: { id: string; jiraKey: string; activeSprintId: number | null }) {
  if (!project.activeSprintId) return;

  think("oversight", "check", "Checking for deadlock...", { projectId: project.id });

  // Throttle: skip if deadlock_resolution memory exists within last 2 hours
  const recentResolution = await prisma.lyraMemory.findFirst({
    where: {
      projectId: project.id,
      category: "observation",
      content: { contains: "deadlock_resolution" },
      createdAt: { gte: new Date(Date.now() - 2 * 60 * 60_000) },
    },
  });

  if (recentResolution) return;

  // Get all "To Do" tickets in active sprint
  const jql = `project = ${project.jiraKey} AND sprint = ${project.activeSprintId} AND status = "To Do" AND issuetype != Epic ORDER BY rank ASC`;
  let tickets: Array<{ id: string; key: string; fields: Record<string, unknown> }>;
  try {
    const results = await searchIssues(jql, 100);
    tickets = results.issues || [];
  } catch (e) {
    console.error(`[Oversight] Deadlock check JQL failed for ${project.jiraKey}:`, e);
    return;
  }

  if (tickets.length === 0) return;

  const dispatcherState = getState();
  const DEV_COMPLETE_STATUSES = ["code review", "qa passed", "done"];

  const abandoned: Array<{ key: string; failedAttempts: number; dependents: string[] }> = [];
  const blockedByAbandoned: string[] = [];
  const workable: string[] = [];

  // First pass: classify each ticket
  for (const ticket of tickets) {
    // Count failures (same logic as dispatcher line 292-298)
    const failedSessions = await prisma.session.count({
      where: { ticketKey: ticket.key, projectId: project.id, status: "failed" },
    });
    const gateFailures = await prisma.qualityGateRun.count({
      where: { ticketKey: ticket.key, projectId: project.id, passed: false },
    });
    const failedAttempts = failedSessions + gateFailures;

    if (failedAttempts >= dispatcherState.maxRetries) {
      abandoned.push({ key: ticket.key, failedAttempts, dependents: [] });
      continue;
    }

    // Check if blocked by any abandoned ticket
    const deps = extractDependencies(ticket);
    const blockers = deps.filter((d) => {
      if (d.type !== "is-blocked-by") return false;
      if (d.status === "done") return false;
      if (DEV_COMPLETE_STATUSES.includes(d.statusName.toLowerCase())) return false;
      return true;
    });

    const isBlockedByAbandonedTicket = blockers.some((b) =>
      abandoned.some((a) => a.key === b.key)
    );

    if (isBlockedByAbandonedTicket) {
      blockedByAbandoned.push(ticket.key);
    } else if (blockers.length > 0) {
      // Blocked by something not yet classified — check if those blockers are also abandoned
      // For simplicity, treat tickets blocked by non-done tickets as potentially stuck
      blockedByAbandoned.push(ticket.key);
    } else {
      workable.push(ticket.key);
    }
  }

  // Also check: do any workable tickets have blockers that are abandoned?
  // (second pass to catch blockers classified after the blocked ticket)
  const abandonedKeys = new Set(abandoned.map((a) => a.key));
  const revisedWorkable: string[] = [];
  for (const key of workable) {
    const ticket = tickets.find((t) => t.key === key);
    if (!ticket) { revisedWorkable.push(key); continue; }
    const deps = extractDependencies(ticket);
    const hasAbandonedBlocker = deps.some(
      (d) => d.type === "is-blocked-by" && abandonedKeys.has(d.key)
    );
    if (hasAbandonedBlocker) {
      blockedByAbandoned.push(key);
    } else {
      revisedWorkable.push(key);
    }
  }

  // Count dependents for each abandoned ticket
  for (const a of abandoned) {
    for (const ticket of tickets) {
      const deps = extractDependencies(ticket);
      if (deps.some((d) => d.type === "is-blocked-by" && d.key === a.key)) {
        a.dependents.push(ticket.key);
      }
    }
  }

  // Not a deadlock if there are workable tickets
  if (revisedWorkable.length > 0 || abandoned.length === 0) return;

  // DEADLOCK DETECTED
  think("oversight", "evaluating",
    `DEADLOCK DETECTED: ${abandoned.length} abandoned tickets blocking ${blockedByAbandoned.length} downstream`,
    { projectId: project.id }
  );

  console.warn(
    `[Oversight] DEADLOCK in ${project.jiraKey}: ${abandoned.length} abandoned, ${blockedByAbandoned.length} blocked, 0 workable`
  );

  lyraEvents.emit("notify", {
    projectId: project.id,
    severity: "critical",
    title: `Sprint deadlock detected`,
    body: `${abandoned.length} abandoned tickets blocking ${blockedByAbandoned.length} downstream. Lyra is analyzing and creating new plans.`,
  });

  // Sort abandoned tickets by number of dependents (most depended-on first)
  abandoned.sort((a, b) => b.dependents.length - a.dependents.length);

  // Get all sprint tickets for project context
  const allSprintJql = `project = ${project.jiraKey} AND sprint = ${project.activeSprintId} AND issuetype != Epic ORDER BY rank ASC`;
  let sprintTickets: { key: string; summary: string; status: string }[] = [];
  try {
    const allResults = await searchIssues(allSprintJql, 100);
    sprintTickets = (allResults.issues || []).map((i) => ({
      key: i.key,
      summary: i.fields?.summary as string || "",
      status: (i.fields?.status as { name: string })?.name || "Unknown",
    }));
  } catch { /* non-fatal */ }

  const resolvedTickets: string[] = [];

  for (const ticket of abandoned) {
    try {
      think("oversight", "evaluating", `Analyzing ${ticket.key}: fetching failure history...`, { projectId: project.id, ticketKey: ticket.key });

      // Fetch full Jira issue
      const issue = await getIssue(ticket.key);
      const summary: string = issue?.fields?.summary ?? ticket.key;
      const description: string = typeof issue?.fields?.description === "string"
        ? issue.fields.description
        : JSON.stringify(issue?.fields?.description || "");

      // Extract acceptance criteria from description
      const descText = description;
      const acLines: string[] = [];
      const lines = descText.split("\n");
      let inAC = false;
      for (const line of lines) {
        if (/\*\*Acceptance Criteria:?\*\*/.test(line) || /^Acceptance Criteria:?\s*$/i.test(line.trim())) {
          inAC = true;
          continue;
        }
        if (inAC) {
          const match = line.match(/^[-*]\s*(?:\[[ x]?\]\s*)?(.+)/);
          if (match) acLines.push(match[1].trim());
          else if (line.match(/^\*\*/)) break;
        }
      }

      // Fetch gate failures
      const gateFailures = await prisma.qualityGateRun.findMany({
        where: { ticketKey: ticket.key, projectId: project.id, passed: false },
        orderBy: { createdAt: "desc" },
        select: { reasoning: true, checks: true },
      });

      // Fetch last 2 session outputs
      const sessionOutputs = await prisma.session.findMany({
        where: { ticketKey: ticket.key, projectId: project.id },
        orderBy: { completedAt: "desc" },
        take: 2,
        select: { output: true, completedAt: true },
      });

      // Fetch triage history
      const triageHistory = await prisma.triageLog.findMany({
        where: { ticketKey: ticket.key, projectId: project.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { action: true, summary: true, actionTaken: true },
      });

      // Call brain for deep analysis
      think("oversight", "evaluating", `Analyzing root cause for ${ticket.key}...`, { projectId: project.id, ticketKey: ticket.key });

      const analysis = await analyzeDeadlockedTicket({
        ticketKey: ticket.key,
        projectId: project.id,
        summary,
        description,
        acceptanceCriteria: acLines,
        gateFailures: gateFailures.map((g) => ({ reasoning: g.reasoning, checks: g.checks })),
        sessionOutputs: sessionOutputs.map((s) => ({ output: s.output || "", completedAt: s.completedAt })),
        sprintTickets,
        triageHistory: triageHistory.map((t) => ({ action: t.action, summary: t.summary, actionTaken: t.actionTaken })),
        dependents: ticket.dependents,
      });

      think("oversight", "acting",
        `Root cause for ${ticket.key}: ${analysis.rootCause.slice(0, 100)}`,
        { projectId: project.id, ticketKey: ticket.key }
      );

      // Only retry if we got a meaningful prompt override
      if (analysis.promptInstructions && analysis.confidence > 0) {
        const reason = `Root cause: ${analysis.rootCause}\nPattern: ${analysis.patternIdentified}\nNew approach: ${analysis.newApproach}`;
        const success = await retryWithNewPlan(ticket.key, project.id, analysis.promptInstructions, reason);

        if (success) {
          resolvedTickets.push(ticket.key);
          think("oversight", "acting", `New plan created for ${ticket.key} — retrying`, { projectId: project.id, ticketKey: ticket.key });
        }
      } else {
        think("oversight", "evaluating", `Low confidence analysis for ${ticket.key} (${analysis.confidence}) — skipping retry`, { projectId: project.id, ticketKey: ticket.key });
      }
    } catch (e) {
      console.error(`[Oversight] Deadlock analysis failed for ${ticket.key}:`, e);
    }
  }

  // Remember the resolution attempt
  if (resolvedTickets.length > 0) {
    await remember(project.id, "observation", {
      event: "deadlock_resolution",
      abandonedTickets: abandoned.map((a) => a.key),
      blockedTickets: blockedByAbandoned,
      resolvedTickets,
      totalAnalyzed: abandoned.length,
    });

    think("oversight", "done",
      `Deadlock resolution: analyzed ${abandoned.length} tickets, retrying ${resolvedTickets.length} with new plans`,
      { projectId: project.id }
    );
  }
}
