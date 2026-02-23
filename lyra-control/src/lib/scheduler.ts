/**
 * Central Scheduler — manages all Lyra background loops.
 * Single start/stop for all periodic tasks.
 * Uses globalThis to persist state across Next.js HMR reloads.
 */

import { start as startDispatcher, stop as stopDispatcher } from "./dispatcher";
import { startQaRunner, stopQaRunner } from "./qa-runner";
import { processQueue } from "./messaging";
import { registerNotificationHandlers } from "./notifications";
import { runDailyStandup, runSprintReview, runSprintRetro, runSprintHealthCheck, runStaleTicketCheck } from "./ceremonies";
import { runOversightCheck } from "./lyra-oversight";
import { reconcileTriageEntries } from "./triage-reconciler";
import { lyraEvents } from "./lyra-events";
import { prisma } from "./db";

interface ScheduledTask {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  timer?: ReturnType<typeof setInterval>;
  lastRun?: Date;
}

// Persist scheduler state across Next.js HMR reloads
interface SchedulerGlobal {
  tasks: ScheduledTask[];
  running: boolean;
  initialized: boolean;
}

const globalForScheduler = globalThis as unknown as {
  __schedulerState: SchedulerGlobal | undefined;
};

const sched: SchedulerGlobal = globalForScheduler.__schedulerState ?? {
  tasks: [],
  running: false,
  initialized: false,
};

if (process.env.NODE_ENV !== "production") {
  globalForScheduler.__schedulerState = sched;
}

// ── Task registration ───────────────────────────────────────────────

function registerTask(
  name: string,
  intervalMs: number,
  handler: () => Promise<void>
) {
  sched.tasks.push({ name, intervalMs, handler });
}

// ── Initialize all tasks ────────────────────────────────────────────

function initTasks() {
  if (sched.initialized) return;
  sched.initialized = true;

  // Register notification event handlers
  registerNotificationHandlers();

  // Message queue flush — every 1 minute
  registerTask("message-queue", 60_000, async () => {
    const result = await processQueue();
    if (result.sent > 0 || result.failed > 0) {
      console.log(
        `[Scheduler] Message queue: ${result.sent} sent, ${result.failed} failed`
      );
    }
  });

  // Stale ticket check — every 30 minutes
  registerTask("stale-tickets", 30 * 60_000, async () => {
    await runStaleTicketCheck();
  });

  // Sprint health check — every hour
  registerTask("sprint-health", 60 * 60_000, async () => {
    await runSprintHealthCheck();
  });

  // Daily standup — check every hour if it's time (8am)
  registerTask("daily-standup", 60 * 60_000, async () => {
    const hour = new Date().getHours();
    if (hour === 8) {
      await runDailyStandup();
    }
  });

  // Lyra active oversight — every 10 minutes
  registerTask("lyra-oversight", 10 * 60_000, async () => {
    await runOversightCheck();
  });

  // Triage reconciliation — every 10 minutes
  registerTask("triage-reconciliation", 10 * 60_000, async () => {
    const triageResult = await reconcileTriageEntries();
    const total = triageResult.resolved + triageResult.ambiguousResolved;
    if (total > 0) {
      console.log(
        `[Scheduler] Triage reconciliation: ${total} resolved, ${triageResult.unchanged} unchanged`
      );
    }
  });

  // Merge queue fallback — every 10 minutes (catches missed pr:approved events)
  registerTask("merge-queue", 10 * 60_000, async () => {
    const { runMergeQueue } = await import("./merge-queue");
    const projects = await prisma.project.findMany({ where: { status: "active" } });
    for (const p of projects) {
      await runMergeQueue(p.id).catch((e) => {
        console.error(`[Scheduler] Merge queue error for ${p.jiraKey}:`, e);
      });
    }
  });

  // Rollback check — every 15 minutes
  registerTask("rollback-check", 15 * 60_000, async () => {
    const { checkAndRollback } = await import("./rollback");
    const projects = await prisma.project.findMany({ where: { status: "active" } });
    for (const p of projects) {
      await checkAndRollback(p.id).catch((e) => {
        console.error(`[Scheduler] Rollback check error for ${p.jiraKey}:`, e);
      });
    }
  });

  // Session recovery — find completed sessions that never got a quality gate
  // This handles server restarts during agent completion (close handler lost)
  registerTask("session-recovery", 5 * 60_000, async () => {
    const { recoverOrphanedSessions } = await import("./dispatcher");
    await recoverOrphanedSessions().catch((e) =>
      console.error("[Scheduler] Session recovery error:", e)
    );
  });

  // Sprint end check — every hour
  registerTask("sprint-end-check", 60 * 60_000, async () => {
    const { generateReleaseNotes } = await import("./release-notes-generator");
    const projects = await prisma.project.findMany({
      where: { status: "active", activeSprintId: { not: null } },
    });
    for (const p of projects) {
      if (!p.activeSprintId) continue;
      const sprint = await prisma.sprint.findFirst({
        where: { projectId: p.id, jiraSprintId: p.activeSprintId },
      });
      if (!sprint || !sprint.endDate) continue;
      if (new Date(sprint.endDate) >= new Date()) continue;

      console.log(`[Pipeline] Sprint ended: ${sprint.name} for ${p.jiraKey}`);

      // Sprint ended — run review, retro, release notes
      await runSprintReview(p.id, sprint.id).catch((e) =>
        console.error(`[Scheduler] Sprint review error for ${p.jiraKey}:`, e)
      );
      await runSprintRetro(p.id, sprint.id).catch((e) =>
        console.error(`[Scheduler] Sprint retro error for ${p.jiraKey}:`, e)
      );

      // Gather ticket data for release notes
      const sessions = await prisma.session.findMany({
        where: {
          projectId: p.id,
          startedAt: { gte: sprint.startDate || undefined },
          completedAt: { lte: sprint.endDate || undefined },
        },
        include: { agent: true },
      });
      const gateRuns = await prisma.qualityGateRun.findMany({
        where: {
          projectId: p.id,
          createdAt: {
            gte: sprint.startDate || undefined,
            lte: sprint.endDate || undefined,
          },
        },
      });

      const completed = sessions.filter((s) => s.status === "completed");
      const failed = sessions.filter((s) => s.status === "failed");
      const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
      const gatePassRate = gateRuns.length > 0
        ? Math.round((gateRuns.filter((g) => g.passed).length / gateRuns.length) * 100)
        : 0;

      const tickets = sessions.map((s) => {
        const gate = gateRuns.find((g) => g.sessionId === s.id);
        return {
          key: s.ticketKey,
          summary: s.ticketKey,
          status: (s.status === "completed" ? "completed" : "failed") as "completed" | "failed",
          gatePassed: gate?.passed ?? null,
          gateReasoning: gate?.reasoning ?? "",
          prUrl: null as string | null,
          prState: null as string | null,
          agent: s.agent.name,
          cost: s.cost,
        };
      });

      await generateReleaseNotes({
        projectId: p.id,
        sprintId: sprint.id,
        sprintName: sprint.name,
        sprintGoal: sprint.goal,
        tickets,
        totals: { completed: completed.length, failed: failed.length, cost: totalCost, gatePassRate },
        projectPath: p.path,
        projectName: p.name,
        runCmd: "npm run dev",
      }).catch((e) =>
        console.error(`[Scheduler] Release notes error for ${p.jiraKey}:`, e)
      );

      // Deactivate sprint
      await prisma.project.update({
        where: { id: p.id },
        data: { activeSprintId: null },
      });
      await prisma.sprint.update({
        where: { id: sprint.id },
        data: { state: "closed" },
      });

      console.log(`[Pipeline] Sprint ${sprint.name} closed for ${p.jiraKey}`);
    }
  });

  // Event-driven: auto-merge on QA approval
  lyraEvents.on("pr:approved", async (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: PR approved — triggering merge queue`);
    const { runMergeQueue } = await import("./merge-queue");
    await runMergeQueue(data.projectId).catch((e) => {
      console.error(`[Scheduler] Event-driven merge queue error:`, e);
    });
  });

  // ── Pipeline Observability Logging ─────────────────────────────────
  lyraEvents.on("agent:completed", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: In Progress → Code Review (agent completed)`);
  });
  lyraEvents.on("agent:failed", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: In Progress → To Do (agent failed, code ${data.exitCode})`);
  });
  lyraEvents.on("gate:passed", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: Quality Gate PASSED`);
  });
  lyraEvents.on("gate:failed", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: Quality Gate FAILED — ${data.reasoning.slice(0, 100)}`);
  });
  lyraEvents.on("pr:created", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: PR created → ${data.prUrl}`);
  });
  lyraEvents.on("qa:assigned", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: Code Review → QA (agent: ${data.agentName})`);
  });
  lyraEvents.on("qa:passed", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: Code Review → QA Passed`);
  });
  lyraEvents.on("qa:failed", (data) => {
    console.log(`[Pipeline] ${data.ticketKey}: QA Failed → To Do (${data.details.slice(0, 100)})`);
  });
  lyraEvents.on("merge:complete", (data) => {
    console.log(`[Pipeline] ${data.ticketKey || "unknown"}: PR #${data.pr} ${data.status}`);
  });
}

// ── Start / Stop ────────────────────────────────────────────────────

export async function startScheduler() {
  if (sched.running) return;

  initTasks();
  sched.running = true;

  // Start dispatcher and QA runner (they manage their own intervals)
  await startDispatcher();
  startQaRunner();

  // Start all registered periodic tasks
  for (const task of sched.tasks) {
    task.timer = setInterval(async () => {
      try {
        await task.handler();
        task.lastRun = new Date();
      } catch (e) {
        console.error(`[Scheduler] ${task.name} error:`, e);
      }
    }, task.intervalMs);
  }

  console.log("[Scheduler] Started all Lyra services");
}

export function stopScheduler() {
  if (!sched.running) return;

  sched.running = false;

  // Stop dispatcher and QA runner
  stopDispatcher();
  stopQaRunner();

  // Stop all periodic tasks
  for (const task of sched.tasks) {
    if (task.timer) {
      clearInterval(task.timer);
      task.timer = undefined;
    }
  }

  console.log("[Scheduler] Stopped all Lyra services");
}

export function getSchedulerState() {
  return {
    running: sched.running,
    tasks: sched.tasks.map((t) => ({
      name: t.name,
      intervalMs: t.intervalMs,
      lastRun: t.lastRun,
      active: !!t.timer,
    })),
  };
}
