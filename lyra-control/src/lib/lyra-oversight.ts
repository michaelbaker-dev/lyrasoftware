/**
 * Lyra Active Oversight — proactive sprint management.
 * Runs periodically to check idle capacity, stuck agents,
 * repeated failures, and overall sprint progress.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "./db";
import { getState, triggerDispatch } from "./dispatcher";
import { decide, remember } from "./lyra-brain";
import { lyraEvents } from "./lyra-events";
import { searchIssues } from "./jira";

const exec = promisify(execFile);

// ── Main entry point ────────────────────────────────────────────────

export async function runOversightCheck(): Promise<void> {
  console.log("[Oversight] Running Lyra oversight check…");

  try {
    const projects = await prisma.project.findMany({
      where: { status: "active" },
    });

    for (const project of projects) {
      await checkIdleCapacity(project);
      await checkStuckAgents(project);
      await checkRepeatedFailures(project);
      await checkSprintProgress(project);
    }
  } catch (e) {
    console.error("[Oversight] Error during oversight check:", e);
  }
}

// ── Check 1: Idle capacity with available work ──────────────────────

async function checkIdleCapacity(project: { id: string; jiraKey: string; activeSprintId: number | null }) {
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
      console.log(
        `[Oversight] ${project.jiraKey}: ${idleAgentCount} idle agent(s) with ${todoCount} "To Do" ticket(s) — triggering dispatch`
      );

      await remember(project.id, "observation", {
        event: "idle_capacity_detected",
        idleAgents: idleAgentCount,
        todoTickets: todoCount,
        activeAgents: dispatcherState.activeAgentCount,
      });

      triggerDispatch();
    }
  } catch (e) {
    console.error(`[Oversight] Idle capacity check failed for ${project.jiraKey}:`, e);
  }
}

// ── Check 2: Stuck agents (no git activity) ─────────────────────────

async function checkStuckAgents(project: { id: string; jiraKey: string }) {
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
  // Find tickets with 3+ failed sessions
  const failedGroups = await prisma.session.groupBy({
    by: ["ticketKey"],
    where: { projectId: project.id, status: "failed" },
    _count: { id: true },
    having: { id: { _count: { gte: 3 } } },
  });

  for (const group of failedGroups) {
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
          const { addComment } = await import("./jira");
          await addComment(
            group.ticketKey,
            `[OVERSIGHT] This story has failed ${group._count.id} times. Lyra recommends splitting it into smaller tasks.\n\nReasoning: ${decision.reasoning}`
          );
          const { transitionToStatus } = await import("./dispatcher");
          await transitionToStatus(group.ticketKey, "Blocked").catch(() => {});
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
    } catch (e) {
      console.error(`[Oversight] Sprint progress check error for ${project.jiraKey}:`, e);
    }
  }
}
