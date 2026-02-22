/**
 * Triage Reconciler — periodic sweep that reconciles open triage entries
 * against actual system state. Self-heals entries that should have been
 * resolved by event listeners but were missed (server restart, timing gaps).
 *
 * Two-tier resolution:
 *   Tier 1: DB-only checks (passing gate run or completed session)
 *   Tier 2: Jira + Lyra Brain for ambiguous cases
 */

import { prisma } from "./db";
import { resolveTriageEntries } from "./triage-lifecycle";
import { getIssue } from "./jira";
import { decide } from "./lyra-brain";

interface ReconcileResult {
  resolved: number;
  ambiguousResolved: number;
  unchanged: number;
  errors: number;
}

export async function reconcileTriageEntries(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    resolved: 0,
    ambiguousResolved: 0,
    unchanged: 0,
    errors: 0,
  };

  // Fetch all open triage entries
  const openEntries = await prisma.triageLog.findMany({
    where: { resolution: { in: ["open", "retrying", "escalated"] } },
    select: {
      id: true,
      ticketKey: true,
      projectId: true,
      createdAt: true,
    },
  });

  if (openEntries.length === 0) return result;

  // ── Tier 1: Definitive resolution (DB only) ─────────────────────

  const unresolvedEntries: typeof openEntries = [];

  for (const entry of openEntries) {
    try {
      // Check for a passing quality gate run created after the triage entry
      const passingGate = await prisma.qualityGateRun.findFirst({
        where: {
          ticketKey: entry.ticketKey,
          projectId: entry.projectId,
          passed: true,
          createdAt: { gt: entry.createdAt },
        },
      });

      if (passingGate) {
        await resolveTriageEntries(entry.ticketKey, entry.projectId);
        result.resolved++;
        continue;
      }

      // Check for a completed session created after the triage entry
      const completedSession = await prisma.session.findFirst({
        where: {
          ticketKey: entry.ticketKey,
          projectId: entry.projectId,
          status: "completed",
          createdAt: { gt: entry.createdAt },
        },
      });

      if (completedSession) {
        await resolveTriageEntries(entry.ticketKey, entry.projectId);
        result.resolved++;
        continue;
      }

      unresolvedEntries.push(entry);
    } catch (e) {
      console.error(
        `[TriageReconciler] Tier 1 error for ${entry.ticketKey}:`,
        e
      );
      result.errors++;
    }
  }

  // ── Tier 2: Ambiguous resolution (Jira + Lyra Brain) ────────────

  // Group remaining entries by ticketKey to avoid duplicate Jira calls
  const byTicket = new Map<string, typeof unresolvedEntries>();
  for (const entry of unresolvedEntries) {
    const key = entry.ticketKey;
    if (!byTicket.has(key)) byTicket.set(key, []);
    byTicket.get(key)!.push(entry);
  }

  for (const [ticketKey, entries] of byTicket) {
    try {
      const issue = await getIssue(ticketKey);
      const jiraStatus = (issue?.fields?.status?.name ?? "").toLowerCase();

      if (["done", "closed", "resolved"].includes(jiraStatus)) {
        // Use the first entry's projectId for the brain call
        const projectId = entries[0].projectId;

        const decision = await decide({
          projectId,
          event: "triage-reconciliation",
          ticketKey,
          question:
            "Triage entry is open but Jira ticket is Done. Should it be auto-resolved?",
          data: {
            jiraStatus: issue.fields.status.name,
            openTriageCount: entries.length,
          },
        });

        if (decision.action === "approve" && decision.confidence >= 0.7) {
          await resolveTriageEntries(ticketKey, projectId);
          result.ambiguousResolved += entries.length;
        } else {
          result.unchanged += entries.length;
        }
      } else {
        result.unchanged += entries.length;
      }
    } catch (e) {
      console.error(
        `[TriageReconciler] Tier 2 error for ${ticketKey}:`,
        e
      );
      result.errors += entries.length;
    }
  }

  return result;
}
