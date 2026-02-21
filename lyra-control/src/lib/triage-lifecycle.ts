/**
 * Triage Lifecycle — auto-resolves triage log entries when downstream
 * events indicate the underlying issue has been fixed.
 */

import { prisma } from "./db";
import {
  lyraEvents,
  type GateResultEvent,
  type QaResultEvent,
} from "./lyra-events";

async function resolveTriageEntries(ticketKey: string, projectId: string) {
  const updated = await prisma.triageLog.updateMany({
    where: {
      ticketKey,
      projectId,
      resolution: { in: ["open", "retrying", "escalated"] },
    },
    data: {
      resolution: "fixed",
      resolvedAt: new Date(),
    },
  });

  if (updated.count > 0) {
    console.log(
      `[TriageLifecycle] Auto-resolved ${updated.count} triage entry/entries for ${ticketKey}`
    );
  }
}

export function registerTriageLifecycle() {
  lyraEvents.on("gate:passed", (data: GateResultEvent) => {
    resolveTriageEntries(data.ticketKey, data.projectId).catch((e) =>
      console.error("[TriageLifecycle] Error resolving on gate:passed:", e)
    );
  });

  lyraEvents.on("qa:passed", (data: QaResultEvent) => {
    resolveTriageEntries(data.ticketKey, data.projectId).catch((e) =>
      console.error("[TriageLifecycle] Error resolving on qa:passed:", e)
    );
  });

  console.log("[TriageLifecycle] Registered lifecycle listeners");
}
