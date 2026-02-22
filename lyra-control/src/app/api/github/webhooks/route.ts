/**
 * GitHub Webhook Endpoint — receives GitHub events and triggers pipeline actions.
 *
 * Events handled:
 * - pull_request.closed (merged) → update Jira ticket to Done
 * - check_suite.completed (failure) → trigger rollback check
 * - pull_request.opened → log PR creation
 */

import { NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import { prisma } from "@/lib/db";
import { lyraEvents } from "@/lib/lyra-events";

async function getWebhookSecret(): Promise<string | null> {
  const setting = await prisma.setting.findUnique({
    where: { key: "github_webhook_secret" },
  });
  return setting?.value || process.env.GITHUB_WEBHOOK_SECRET || null;
}

function verifySignature(
  payload: string,
  signature: string | null,
  secret: string
): boolean {
  if (!signature) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
  try {
    return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const body = await request.text();
  const event = request.headers.get("x-github-event");
  const signature = request.headers.get("x-hub-signature-256");

  // Validate webhook signature if secret is configured
  const secret = await getWebhookSecret();
  if (secret) {
    if (!verifySignature(body, signature, secret)) {
      console.warn("[Webhook] Invalid GitHub webhook signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = payload.action as string | undefined;
  const repo = (payload.repository as { name?: string })?.name;

  // Find the project associated with this repo
  const project = repo
    ? await prisma.project.findFirst({ where: { githubRepo: repo } })
    : null;

  console.log(`[Webhook] Received ${event}${action ? `.${action}` : ""} for ${repo || "unknown"}`);

  // ── pull_request events ────────────────────────────────────────────
  if (event === "pull_request") {
    const pr = payload.pull_request as {
      number?: number;
      merged?: boolean;
      title?: string;
      head?: { ref?: string };
    } | undefined;

    if (action === "closed" && pr?.merged) {
      // PR merged — update Jira ticket to Done
      const ticketMatch = pr.head?.ref?.match(/([A-Z]+-\d+)/i) ||
        pr.title?.match(/([A-Z]+-\d+)/i);
      const ticketKey = ticketMatch?.[1]?.toUpperCase();

      console.log(`[Pipeline] ${ticketKey || "unknown"}: PR #${pr.number} merged → Done`);

      if (project) {
        await prisma.auditLog.create({
          data: {
            projectId: project.id,
            action: "pr.merged",
            actor: "github-webhook",
            details: JSON.stringify({
              pr: pr.number,
              ticketKey,
              autoMerge: true,
            }),
          },
        });

        // Transition Jira ticket to Done
        if (ticketKey) {
          try {
            const { getTransitions, transitionIssue, addComment } = await import("@/lib/jira");
            const { transitions } = await getTransitions(ticketKey);
            const done = transitions?.find(
              (t: { name: string }) => t.name.toLowerCase().includes("done")
            );
            if (done) {
              await transitionIssue(ticketKey, done.id);
              await addComment(ticketKey, `[LYRA] PR #${pr.number} merged via webhook. Ticket marked Done.`);
              console.log(`[Pipeline] ${ticketKey}: Done (webhook)`);
            }
          } catch (e) {
            console.error(`[Webhook] Jira transition error for ${ticketKey}:`, e);
          }
        }
      }

      return NextResponse.json({ handled: true, action: "pr_merged", ticketKey });
    }

    if (action === "opened") {
      console.log(`[Pipeline] PR #${(pr as { number?: number })?.number} opened for ${repo}`);
      if (project) {
        await prisma.auditLog.create({
          data: {
            projectId: project.id,
            action: "pr.opened",
            actor: "github-webhook",
            details: JSON.stringify({ pr: (pr as { number?: number })?.number }),
          },
        });
      }
      return NextResponse.json({ handled: true, action: "pr_opened" });
    }
  }

  // ── check_suite events ─────────────────────────────────────────────
  if (event === "check_suite") {
    const checkSuite = payload.check_suite as {
      conclusion?: string;
      head_branch?: string;
    } | undefined;

    if (action === "completed" && checkSuite?.conclusion === "failure") {
      const branch = checkSuite.head_branch;
      const baseBranch = project?.baseBranch || "main";

      if (branch === baseBranch && project) {
        console.log(`[Pipeline] CI failed on ${baseBranch} for ${repo} — triggering rollback check`);
        const { checkAndRollback } = await import("@/lib/rollback");
        const result = await checkAndRollback(project.id).catch((e) => {
          console.error(`[Webhook] Rollback error for ${repo}:`, e);
          return { action: "none" as const, details: (e as Error).message };
        });

        return NextResponse.json({ handled: true, action: "ci_failure_rollback", result });
      }
    }
  }

  // Unknown or unhandled event
  return NextResponse.json({ handled: false, event, action });
}
