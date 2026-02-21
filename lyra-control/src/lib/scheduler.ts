/**
 * Central Scheduler — manages all Lyra background loops.
 * Single start/stop for all periodic tasks.
 * Uses globalThis to persist state across Next.js HMR reloads.
 */

import { start as startDispatcher, stop as stopDispatcher } from "./dispatcher";
import { startQaRunner, stopQaRunner } from "./qa-runner";
import { processQueue } from "./messaging";
import { registerNotificationHandlers } from "./notifications";
import { runDailyStandup, runSprintHealthCheck, runStaleTicketCheck } from "./ceremonies";
import { runOversightCheck } from "./lyra-oversight";

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
