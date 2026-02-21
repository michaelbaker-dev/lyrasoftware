/**
 * Rollback Automation — detects post-merge CI failures and auto-reverts.
 * Polls CI status on main/develop after merges.
 * If CI fails, creates revert PR, transitions ticket back, notifies PO.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import { addComment, createIssue } from "./jira";
import { remember } from "./lyra-brain";

const exec = promisify(execFile);

interface CIStatus {
  state: string; // "success" | "failure" | "pending"
  sha: string;
  description: string;
}

async function getLatestCIStatus(
  repo: string,
  branch: string
): Promise<CIStatus | null> {
  try {
    const { stdout } = await exec("gh", [
      "api",
      `repos/michaelbaker-dev/${repo}/commits/${branch}/status`,
      "--jq",
      ".state + \"|\" + .sha + \"|\" + (.statuses[0].description // \"\")",
    ]);

    const [state, sha, description] = stdout.trim().split("|");
    return { state, sha, description };
  } catch {
    return null;
  }
}

export async function checkAndRollback(projectId: string): Promise<{
  action: "none" | "reverted";
  details?: string;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project?.githubRepo) {
    return { action: "none", details: "No repo configured" };
  }

  const baseBranch = project.baseBranch || "main";
  const status = await getLatestCIStatus(project.githubRepo, baseBranch);

  if (!status || status.state !== "failure") {
    return { action: "none" };
  }

  // CI is failing on base branch — find the most recent merge
  try {
    const { stdout: logOutput } = await exec("gh", [
      "api",
      `repos/michaelbaker-dev/${project.githubRepo}/commits`,
      "--jq",
      ".[0] | .sha + \"|\" + .commit.message",
      "-f",
      `sha=${baseBranch}`,
      "-f",
      "per_page=1",
    ]);

    const [commitSha, commitMessage] = logOutput.trim().split("|");

    // Extract ticket key from commit message
    const ticketMatch = commitMessage?.match(
      /([A-Z]+-\d+)/
    );
    const ticketKey = ticketMatch?.[1];

    // Create revert PR
    const { stdout: revertOutput } = await exec("gh", [
      "api",
      `repos/michaelbaker-dev/${project.githubRepo}/git/refs`,
      "-f",
      `ref=refs/heads/revert-${commitSha.slice(0, 7)}`,
      "-f",
      `sha=${commitSha}~1`,
    ]);

    // Actually create the revert via gh CLI
    await exec("gh", [
      "pr",
      "create",
      "--repo",
      `michaelbaker-dev/${project.githubRepo}`,
      "--title",
      `revert: ${commitMessage?.slice(0, 60)}`,
      "--body",
      [
        "## Auto-Revert",
        "",
        `CI failed on \`${baseBranch}\` after merge.`,
        `Reverting commit: ${commitSha}`,
        ticketKey ? `\nJira: https://mbakers.atlassian.net/browse/${ticketKey}` : "",
        "",
        "This revert was created automatically by Lyra.",
      ].join("\n"),
      "--head",
      `revert-${commitSha.slice(0, 7)}`,
      "--base",
      baseBranch,
    ]);

    // Transition ticket back if found
    if (ticketKey) {
      await addComment(
        ticketKey,
        `CI failed after merge. Lyra created a revert PR. Ticket sent back for investigation.`
      );

      // Create a bug ticket
      await createIssue(
        project.jiraKey,
        "Bug",
        `CI regression from ${ticketKey}`,
        `CI failed on ${baseBranch} after merging ${ticketKey}.\n\nCommit: ${commitSha}\nMessage: ${commitMessage}\n\nA revert PR has been created. Investigate the root cause.`
      );
    }

    await remember(projectId, "escalation", {
      type: "rollback",
      commitSha,
      commitMessage,
      ticketKey,
    });

    lyraEvents.emit("notify", {
      projectId,
      severity: "critical",
      title: `CI Failure — Auto-revert: ${commitMessage?.slice(0, 50)}`,
      body: `CI failed on ${baseBranch}. Revert PR created for commit ${commitSha.slice(0, 7)}. ${ticketKey ? `Ticket ${ticketKey} needs investigation.` : ""}`,
    });

    return {
      action: "reverted",
      details: `Reverted ${commitSha.slice(0, 7)}: ${commitMessage}`,
    };
  } catch (e) {
    console.error("[Rollback] Failed to create revert:", e);
    return { action: "none", details: `Revert failed: ${(e as Error).message}` };
  }
}
