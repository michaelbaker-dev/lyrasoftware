/**
 * Notification system — maps Lyra events to notifications with severity routing.
 * Listens on the event bus and dispatches via the messaging system.
 * Posts rich Slack-formatted messages and threads ticket-related events.
 */

import { lyraEvents } from "./lyra-events";
import { sendNotification } from "./messaging";
import {
  startSlackThread,
  replyInThread,
  getLatestThread,
} from "./messaging/slack";

// ── Helpers ─────────────────────────────────────────────────────────

/** Post a threaded reply for ticket events. If no thread exists, start one. */
async function postToTicketThread(
  projectId: string,
  ticketKey: string,
  text: string
): Promise<void> {
  try {
    const threadType = `ticket:${ticketKey}`;
    const existing = await getLatestThread(projectId, threadType);

    if (existing) {
      await replyInThread(existing.channelId, existing.threadTs, text);
    } else {
      await startSlackThread(
        projectId,
        threadType,
        `*${ticketKey}* — ticket activity thread`,
        ticketKey
      );
      // Now find the thread we just created and reply in it
      const thread = await getLatestThread(projectId, threadType);
      if (thread) {
        await replyInThread(thread.channelId, thread.threadTs, text);
      }
    }
  } catch (e) {
    console.error(`[Notifications] Slack thread error for ${ticketKey}:`, e);
  }
}

// ── Event-to-notification mapping ───────────────────────────────────

export function registerNotificationHandlers(): void {
  lyraEvents.on("agent:completed", async (data) => {
    try {
      const body = [
        `*Agent:* ${data.agentName}`,
        `*Ticket:* ${data.ticketKey}`,
        `*Branch:* \`${data.branch}\``,
        `*Summary:* ${data.summary}`,
        `Quality gate will evaluate next.`,
      ].join("\n");

      await sendNotification({
        projectId: data.projectId,
        severity: "info",
        title: `Agent completed: ${data.ticketKey}`,
        body,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:white_check_mark: *${data.agentName}* completed work on \`${data.branch}\`\n${data.summary}`
      );
    } catch (e) {
      console.error("[Notifications] agent:completed handler error:", e);
    }
  });

  lyraEvents.on("agent:failed", async (data) => {
    try {
      const body = [
        `*Agent:* ${data.agentName}`,
        `*Ticket:* ${data.ticketKey}`,
        `*Exit code:* ${data.exitCode}`,
        data.error ? `*Error:* ${data.error}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      await sendNotification({
        projectId: data.projectId,
        severity: "critical",
        title: `Agent failed: ${data.ticketKey}`,
        body,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:x: *${data.agentName}* failed (exit ${data.exitCode})${data.error ? `\n> ${data.error}` : ""}`
      );
    } catch (e) {
      console.error("[Notifications] agent:failed handler error:", e);
    }
  });

  lyraEvents.on("gate:passed", async (data) => {
    try {
      const checks = data.checks
        .map((c) => `:white_check_mark: ${c.name}`)
        .join("\n");

      await sendNotification({
        projectId: data.projectId,
        severity: "info",
        title: `Quality gate passed: ${data.ticketKey}`,
        body: `${data.reasoning}\n\n${checks}`,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:shield: *Quality gate passed*\n${checks}\n> ${data.reasoning}`
      );
    } catch (e) {
      console.error("[Notifications] gate:passed handler error:", e);
    }
  });

  lyraEvents.on("gate:failed", async (data) => {
    try {
      const failedChecks = data.checks
        .filter((c) => !c.passed)
        .map((c) => `:x: *${c.name}:* ${c.details.slice(0, 200)}`);
      const passedChecks = data.checks
        .filter((c) => c.passed)
        .map((c) => `:white_check_mark: ${c.name}`);

      await sendNotification({
        projectId: data.projectId,
        severity: "warning",
        title: `Quality gate failed: ${data.ticketKey}`,
        body: [
          data.reasoning,
          "",
          "Failed checks:",
          ...failedChecks,
          "",
          "Passed:",
          ...passedChecks,
        ].join("\n"),
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:no_entry: *Quality gate failed* — ticket sent back\n${failedChecks.join("\n")}\n> ${data.reasoning}`
      );
    } catch (e) {
      console.error("[Notifications] gate:failed handler error:", e);
    }
  });

  lyraEvents.on("qa:assigned", async (data) => {
    try {
      await sendNotification({
        projectId: data.projectId,
        severity: "info",
        title: `QA assigned: ${data.ticketKey}`,
        body: `*Agent:* ${data.agentName}\n*Branch:* \`${data.prBranch}\``,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:mag: *${data.agentName}* (QA) assigned to review \`${data.prBranch}\``
      );
    } catch (e) {
      console.error("[Notifications] qa:assigned handler error:", e);
    }
  });

  lyraEvents.on("qa:passed", async (data) => {
    try {
      await sendNotification({
        projectId: data.projectId,
        severity: "info",
        title: `QA passed: ${data.ticketKey}`,
        body: data.details,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:white_check_mark: *QA passed*\n${data.details}`
      );
    } catch (e) {
      console.error("[Notifications] qa:passed handler error:", e);
    }
  });

  lyraEvents.on("qa:failed", async (data) => {
    try {
      await sendNotification({
        projectId: data.projectId,
        severity: "warning",
        title: `QA failed: ${data.ticketKey}`,
        body: `${data.details}\n\nTicket sent back for rework.`,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:warning: *QA failed* — sent back for rework\n${data.details}`
      );
    } catch (e) {
      console.error("[Notifications] qa:failed handler error:", e);
    }
  });

  lyraEvents.on("pr:created", async (data) => {
    try {
      await sendNotification({
        projectId: data.projectId,
        severity: "info",
        title: `PR created: ${data.ticketKey}`,
        body: `*Branch:* \`${data.branch}\`\n*PR:* ${data.prUrl}`,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:rocket: *PR created*\nBranch: \`${data.branch}\`\n${data.prUrl}`
      );
    } catch (e) {
      console.error("[Notifications] pr:created handler error:", e);
    }
  });

  lyraEvents.on("pr:approved", async (data) => {
    try {
      await sendNotification({
        projectId: data.projectId,
        severity: "info",
        title: `PR approved: ${data.ticketKey}`,
        body: `Lyra approved merge: ${data.prUrl}`,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `:tada: *PR approved and merging*\n${data.prUrl}`
      );
    } catch (e) {
      console.error("[Notifications] pr:approved handler error:", e);
    }
  });

  lyraEvents.on("sprint:updated", async (data) => {
    try {
      const pct =
        data.plannedPoints > 0
          ? Math.round((data.completedPoints / data.plannedPoints) * 100)
          : 0;

      await sendNotification({
        projectId: data.projectId,
        severity: "info",
        title: "Sprint progress updated",
        body: `*Completed:* ${data.completedPoints}/${data.plannedPoints} points (${pct}%)`,
      });
    } catch (e) {
      console.error("[Notifications] sprint:updated handler error:", e);
    }
  });

  lyraEvents.on("lyra:decision", async (data) => {
    try {
      // Only notify on meaningful decisions
      if (data.confidence < 0.5 || data.action === "error") return;

      const severity = data.action === "escalate" ? "warning" : "info";
      const confidenceBar = "`" + "\u2588".repeat(Math.round(data.confidence * 10)) + "\u2591".repeat(10 - Math.round(data.confidence * 10)) + `\` ${Math.round(data.confidence * 100)}%`;

      await sendNotification({
        projectId: data.projectId,
        severity,
        title: `Lyra decision: ${data.action}`,
        body: `*Action:* ${data.action}\n*Confidence:* ${confidenceBar}\n*Reasoning:* ${data.reasoning}`,
      });
    } catch (e) {
      console.error("[Notifications] lyra:decision handler error:", e);
    }
  });

  lyraEvents.on("failure:analyzed", async (data) => {
    try {
      const { analysis, actionTaken } = data;
      const isUrgent = analysis.action === "escalate" || analysis.action === "block_ticket";
      const isReassign = analysis.action === "reassign";
      const severity = isUrgent ? "critical" : isReassign ? "warning" : "info";

      const icon = isUrgent ? ":rotating_light:" : isReassign ? ":arrows_counterclockwise:" : ":mag:";
      const colorLabel = isUrgent ? "RED" : isReassign ? "YELLOW" : "GREEN";

      const body = [
        `${icon} *Failure Triage* [${colorLabel}]`,
        `*Ticket:* ${data.ticketKey}`,
        `*Category:* ${analysis.category}`,
        `*Summary:* ${analysis.summary}`,
        `*Suggested Fix:* ${analysis.suggestedFix}`,
        analysis.rootCause ? `*Root Cause:* ${analysis.rootCause}` : "",
        analysis.reassignTo ? `*Reassign To:* ${analysis.reassignTo}` : "",
        `*Action Taken:* ${actionTaken}`,
        `*Confidence:* ${Math.round(analysis.confidence * 100)}%`,
      ]
        .filter(Boolean)
        .join("\n");

      await sendNotification({
        projectId: data.projectId,
        severity,
        title: `Triage: ${data.ticketKey} → ${analysis.action}`,
        body,
      });

      await postToTicketThread(
        data.projectId,
        data.ticketKey,
        `${icon} *Auto-triage: ${analysis.action}*\n${analysis.summary}\n> Fix: ${analysis.suggestedFix}`
      );
    } catch (e) {
      console.error("[Notifications] failure:analyzed handler error:", e);
    }
  });

  // Generic notify event (used by dispatcher, team-manager, rollback)
  lyraEvents.on("notify", async (data) => {
    try {
      await sendNotification({
        projectId: data.projectId,
        severity: data.severity,
        title: data.title,
        body: data.body,
      });
    } catch (e) {
      console.error("[Notifications] notify handler error:", e);
    }
  });

  console.log("[Notifications] Event handlers registered (with Slack threading)");
}
