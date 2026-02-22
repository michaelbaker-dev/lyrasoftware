/**
 * App initialization — recovers orphaned agents/sessions and auto-starts
 * the Lyra scheduler if any project has an active sprint.
 *
 * Uses globalThis to ensure init only runs once, even across HMR reloads.
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { prisma } from "./db";
import { startScheduler } from "./scheduler";
import { triggerDispatch } from "./dispatcher";
import { getTransitions, transitionIssue } from "./jira";
import { registerTriageLifecycle } from "./triage-lifecycle";
import { reconcileTriageEntries } from "./triage-reconciler";

// Persist init state across Next.js HMR reloads
const globalForInit = globalThis as unknown as {
  __lyraInitPromise: Promise<void> | undefined;
};

export function ensureLyraRunning() {
  if (!globalForInit.__lyraInitPromise) {
    globalForInit.__lyraInitPromise = doInit();
  }
  return globalForInit.__lyraInitPromise;
}

async function doInit() {
  try {
    // Register triage lifecycle event listeners
    registerTriageLifecycle();

    // Recover orphaned agents — any agent marked "running" has no live process
    // after a server restart, so reset them to idle
    const orphanedAgents = await prisma.agent.updateMany({
      where: { status: "running" },
      data: { status: "idle", currentTicket: null, startedAt: null },
    });
    if (orphanedAgents.count > 0) {
      console.log(`[Init] Recovered ${orphanedAgents.count} orphaned agent(s) — reset to idle`);
    }

    // Recover orphaned sessions — any session still "running" is dead
    // First, get the ticket keys so we can transition them back in Jira
    const orphanedSessionList = await prisma.session.findMany({
      where: { status: "running" },
      select: { id: true, ticketKey: true, worktreePath: true, output: true },
    });

    if (orphanedSessionList.length > 0) {
      // Preserve claude-progress.txt contents before marking as failed
      for (const session of orphanedSessionList) {
        try {
          const progressFile = join(session.worktreePath, "claude-progress.txt");
          if (existsSync(progressFile)) {
            const progress = readFileSync(progressFile, "utf-8");
            const existingOutput = session.output || "";
            await prisma.session.update({
              where: { id: session.id },
              data: {
                output: existingOutput + "\n\n--- claude-progress.txt (preserved on crash) ---\n" + progress,
              },
            });
            console.log(`[Init] Preserved claude-progress.txt for session ${session.ticketKey}`);
          }
        } catch {
          // Non-fatal — progress file preservation failed
        }
      }

      await prisma.session.updateMany({
        where: { status: "running" },
        data: { status: "failed", completedAt: new Date() },
      });
      console.log(`[Init] Marked ${orphanedSessionList.length} orphaned session(s) as failed`);

      // Transition orphaned tickets back to "To Do" in Jira
      const ticketKeys = [...new Set(orphanedSessionList.map((s) => s.ticketKey))];
      for (const ticketKey of ticketKeys) {
        try {
          const { transitions } = await getTransitions(ticketKey);
          const toDoTransition = transitions?.find(
            (t: { name: string }) => t.name.toLowerCase() === "to do"
          );
          if (toDoTransition) {
            await transitionIssue(ticketKey, toDoTransition.id);
            console.log(`[Init] Transitioned ${ticketKey} back to "To Do"`);
          }
        } catch (e) {
          console.warn(`[Init] Could not transition ${ticketKey} back to To Do:`, e);
        }
      }
    }

    // Reconcile stale triage entries against actual state
    try {
      const triageResult = await reconcileTriageEntries();
      const total = triageResult.resolved + triageResult.ambiguousResolved;
      if (total > 0) {
        console.log(`[Init] Reconciled ${total} stale triage entries`);
      }
    } catch (e) {
      console.error("[Init] Triage reconciliation failed (non-fatal):", e);
    }

    const active = await prisma.project.findFirst({
      where: { status: "active", activeSprintId: { not: null } },
    });
    if (active) {
      console.log(`[Init] Active sprint found for project "${active.name}" — starting scheduler`);
      await startScheduler();

      // Trigger an immediate dispatch after restart to pick up orphaned work
      setTimeout(() => triggerDispatch(), 5000);
    }
  } catch (e) {
    console.error("[Init] Failed during initialization:", e);
  }
}
