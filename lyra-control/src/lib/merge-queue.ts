/**
 * Merge Queue — merges completed PRs in dependency order.
 *
 * Flow:
 * 1. List all open PRs for the project
 * 2. Match PRs to Jira tickets (extract ticket key from branch name or title)
 * 3. Fetch dependency info from Jira for each ticket
 * 4. Topological sort: merge blockers before dependents
 * 5. For each PR in order:
 *    a. Pull latest base branch
 *    b. Attempt squash merge via gh CLI
 *    c. On success: transition Jira ticket to Done
 *    d. On conflict: skip and report
 * 6. Return detailed results
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { listOpenPRs, mergePR, resolveGitHubToken, type PullRequestInfo } from "./github";
import { getIssue, extractDependencies, transitionIssue, addComment, getTransitions } from "./jira";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";

const exec = promisify(execFile);

export interface MergeResult {
  pr: number;
  ticketKey: string | null;
  title: string;
  status: "merged" | "skipped" | "conflict" | "error";
  message: string;
}

export interface MergeQueueResult {
  results: MergeResult[];
  merged: number;
  skipped: number;
  conflicts: number;
  errors: number;
}

/**
 * Extract Jira ticket key from a PR branch name or title.
 * Matches patterns like: feat/PROJ-123-description or "PROJ-123: title"
 */
function extractTicketKey(pr: PullRequestInfo, jiraKey: string): string | null {
  const pattern = new RegExp(`(${jiraKey}-\\d+)`, "i");
  const branchMatch = pr.headRefName.match(pattern);
  if (branchMatch) return branchMatch[1].toUpperCase();
  const titleMatch = pr.title.match(pattern);
  if (titleMatch) return titleMatch[1].toUpperCase();
  return null;
}

/**
 * Topological sort of PRs based on Jira dependency links.
 * PRs whose tickets are blockers come first.
 */
async function sortByDependencyOrder(
  prs: Array<{ pr: PullRequestInfo; ticketKey: string | null }>
): Promise<Array<{ pr: PullRequestInfo; ticketKey: string | null }>> {
  // Fetch dependencies for each ticket
  const depMap = new Map<string, string[]>(); // ticketKey -> [blocked-by keys]

  for (const item of prs) {
    if (!item.ticketKey) continue;
    try {
      const issue = await getIssue(item.ticketKey);
      if (!issue) continue;
      const deps = extractDependencies(issue);
      const blockedBy = deps
        .filter((d) => d.type === "is-blocked-by")
        .map((d) => d.key);
      depMap.set(item.ticketKey, blockedBy);
    } catch {
      // Can't fetch deps — treat as no dependencies
      depMap.set(item.ticketKey, []);
    }
  }

  // Kahn's algorithm for topological sort
  const ticketKeys = new Set(prs.filter((p) => p.ticketKey).map((p) => p.ticketKey!));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>(); // blocker -> [dependents]

  for (const key of ticketKeys) {
    inDegree.set(key, 0);
    adjacency.set(key, []);
  }

  for (const [key, blockedBy] of depMap) {
    for (const blocker of blockedBy) {
      if (ticketKeys.has(blocker)) {
        adjacency.get(blocker)?.push(key);
        inDegree.set(key, (inDegree.get(key) || 0) + 1);
      }
    }
  }

  const sorted: string[] = [];
  const queue: string[] = [];

  for (const [key, degree] of inDegree) {
    if (degree === 0) queue.push(key);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted.push(current);
    for (const dependent of adjacency.get(current) || []) {
      const newDegree = (inDegree.get(dependent) || 1) - 1;
      inDegree.set(dependent, newDegree);
      if (newDegree === 0) queue.push(dependent);
    }
  }

  // Add any remaining (cyclic deps) at the end
  for (const key of ticketKeys) {
    if (!sorted.includes(key)) sorted.push(key);
  }

  // Build result: sorted tickets first, then PRs without ticket keys
  const ticketToPr = new Map(
    prs.filter((p) => p.ticketKey).map((p) => [p.ticketKey!, p])
  );
  const result: typeof prs = [];

  for (const key of sorted) {
    const item = ticketToPr.get(key);
    if (item) result.push(item);
  }

  // Append PRs without ticket keys at the end
  for (const item of prs) {
    if (!item.ticketKey) result.push(item);
  }

  return result;
}

/**
 * Transition a Jira ticket to Done status.
 */
async function transitionToDone(ticketKey: string): Promise<boolean> {
  try {
    const { transitions } = await getTransitions(ticketKey);
    const done = transitions?.find(
      (t: { name: string }) =>
        t.name.toLowerCase() === "done" || t.name.toLowerCase().includes("done")
    );
    if (!done) return false;
    await transitionIssue(ticketKey, done.id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Attempt to rebase a PR branch onto the latest base branch.
 * Creates a temp worktree, rebases, force-pushes, then cleans up.
 */
async function attemptRebase(
  projectPath: string,
  headBranch: string,
  baseBranch: string,
  projectId: string
): Promise<{ success: boolean; error?: string }> {
  const worktreeDir = join(projectPath, "worktrees");
  const worktreePath = join(worktreeDir, `rebase-${Date.now()}`);
  const token = await resolveGitHubToken(projectId);
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

  try {
    mkdirSync(worktreeDir, { recursive: true });

    // Fetch latest remote state
    await exec("git", ["fetch", "origin"], { cwd: projectPath, timeout: 60_000 });

    // Remove any existing worktree that has this branch checked out
    try {
      const { stdout: wtList } = await exec("git", ["worktree", "list", "--porcelain"], {
        cwd: projectPath, timeout: 10_000,
      });
      // Parse porcelain output to find worktree with this branch
      const blocks = wtList.split("\n\n");
      for (const block of blocks) {
        if (block.includes(`branch refs/heads/${headBranch}`)) {
          const pathLine = block.split("\n").find((l: string) => l.startsWith("worktree "));
          if (pathLine) {
            const oldPath = pathLine.replace("worktree ", "");
            // Don't remove the main worktree
            if (oldPath !== projectPath) {
              await exec("git", ["worktree", "remove", oldPath, "--force"], {
                cwd: projectPath, timeout: 30_000,
              });
            }
          }
        }
      }
    } catch { /* non-fatal — worktree may not exist */ }

    // Prune stale worktree references
    await exec("git", ["worktree", "prune"], { cwd: projectPath, timeout: 10_000 });

    // Create worktree on the PR branch
    await exec("git", ["worktree", "add", worktreePath, headBranch], {
      cwd: projectPath, timeout: 30_000,
    });

    // Rebase onto latest base
    await exec("git", ["rebase", `origin/${baseBranch}`], {
      cwd: worktreePath, timeout: 120_000,
    });

    // Force-push the rebased branch
    await exec("git", ["push", "--force-with-lease", "origin", headBranch], {
      cwd: worktreePath, env, timeout: 60_000,
    });

    return { success: true };
  } catch (e) {
    // Abort any in-progress rebase
    try {
      await exec("git", ["rebase", "--abort"], { cwd: worktreePath });
    } catch { /* may not be in rebase state */ }
    return { success: false, error: (e as Error).message };
  } finally {
    // Always clean up the temp worktree
    try {
      if (existsSync(worktreePath)) {
        await exec("git", ["worktree", "remove", worktreePath, "--force"], {
          cwd: projectPath, timeout: 30_000,
        });
      }
    } catch { /* non-fatal */ }
  }
}

/**
 * Run the merge queue for a project.
 * Fetches open PRs, sorts by dependency order, rebases and merges sequentially.
 */
export async function runMergeQueue(projectId: string): Promise<MergeQueueResult> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project?.githubRepo) {
    throw new Error("Project has no GitHub repo configured");
  }

  const repoName = project.githubRepo;
  const baseBranch = project.baseBranch || "main";

  // 1. List open PRs
  const openPRs = await listOpenPRs(repoName, projectId);
  if (openPRs.length === 0) {
    return { results: [], merged: 0, skipped: 0, conflicts: 0, errors: 0 };
  }

  // 2. Match PRs to tickets and filter to only those targeting our base branch
  const prItems = openPRs
    .filter((pr) => pr.baseRefName === baseBranch)
    .map((pr) => ({
      pr,
      ticketKey: extractTicketKey(pr, project.jiraKey),
    }));

  // 3. Sort by dependency order
  const sorted = await sortByDependencyOrder(prItems);

  // 4. Merge sequentially
  const results: MergeResult[] = [];
  let merged = 0;
  let skipped = 0;
  let conflicts = 0;
  let errors = 0;

  // Pull latest base in the project directory before merging
  try {
    await exec("git", ["fetch", "origin", baseBranch], { cwd: project.path });
  } catch {
    // Non-fatal — gh merge doesn't need local fetch
  }

  for (const item of sorted) {
    const { pr, ticketKey } = item;

    // Attempt rebase onto latest base branch before merging
    console.log(`[MergeQueue] Rebasing PR #${pr.number} (${pr.headRefName}) onto ${baseBranch}`);

    lyraEvents.emit("merge:progress", {
      projectId, pr: pr.number, ticketKey, status: "merging",
    });

    const rebaseResult = await attemptRebase(
      project.path, pr.headRefName, baseBranch, projectId
    );

    if (!rebaseResult.success) {
      // True conflict — rebase could not resolve
      conflicts++;
      results.push({
        pr: pr.number, ticketKey, title: pr.title,
        status: "conflict",
        message: `Auto-rebase failed: ${rebaseResult.error?.slice(0, 200)}`,
      });
      if (ticketKey) {
        await addComment(ticketKey,
          `[LYRA] Merge queue: PR #${pr.number} has conflicts that could not be auto-rebased onto ${baseBranch}. Manual resolution needed.`
        ).catch(() => {});
      }
      continue;
    }

    // Rebase succeeded — wait for GitHub to update mergeable status
    await new Promise((r) => setTimeout(r, 5000));

    // Attempt squash merge
    const mergeResult = await mergePR(repoName, pr.number, projectId);

    if (mergeResult.merged) {
      merged++;
      results.push({
        pr: pr.number, ticketKey, title: pr.title,
        status: "merged", message: "Rebased and squash-merged",
      });

      if (ticketKey) {
        const transitioned = await transitionToDone(ticketKey);
        if (transitioned) {
          await addComment(ticketKey,
            `[LYRA] PR #${pr.number} merged to ${baseBranch}. Issue resolved.`
          ).catch(() => {});
        }
      }

      lyraEvents.emit("merge:complete", {
        projectId, pr: pr.number, ticketKey, status: "merged",
      });

      // Pause to let GitHub update base branch
      await new Promise((r) => setTimeout(r, 3000));
    } else {
      // Merge failed despite successful rebase — likely CI or permissions
      const isConflict = mergeResult.error?.toLowerCase().includes("conflict") ||
        mergeResult.error?.toLowerCase().includes("not mergeable");

      if (isConflict) {
        conflicts++;
        results.push({
          pr: pr.number, ticketKey, title: pr.title,
          status: "conflict",
          message: `Rebase succeeded but merge still conflicting: ${mergeResult.error?.slice(0, 200)}`,
        });
      } else {
        errors++;
        results.push({
          pr: pr.number, ticketKey, title: pr.title,
          status: "error",
          message: mergeResult.error?.slice(0, 300) || "Unknown merge error",
        });
      }
    }
  }

  // Also count PRs not targeting base branch as skipped
  const nonBasePRs = openPRs.filter((pr) => pr.baseRefName !== baseBranch);
  for (const pr of nonBasePRs) {
    skipped++;
    results.push({
      pr: pr.number,
      ticketKey: extractTicketKey(pr, project.jiraKey),
      title: pr.title,
      status: "skipped",
      message: `PR targets ${pr.baseRefName}, not ${baseBranch}`,
    });
  }

  // Audit log
  await prisma.auditLog.create({
    data: {
      projectId,
      action: "merge_queue.run",
      actor: "lyra",
      details: JSON.stringify({ merged, skipped, conflicts, errors, total: results.length }),
    },
  });

  // Pull latest after merges so local repo is up to date
  try {
    await exec("git", ["pull", "--ff-only", "origin", baseBranch], { cwd: project.path });
  } catch {
    // Non-fatal
  }

  return { results, merged, skipped, conflicts, errors };
}
