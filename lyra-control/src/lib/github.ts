/**
 * GitHub client wrapping the gh CLI for Lyra Control.
 * Handles repo creation, branch protection, and PR management.
 * Org loaded from database settings, falling back to env vars.
 * Supports per-project GitHub PATs with a default fallback.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "./db";

const exec = promisify(execFile);

async function getOrg(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "github_org" },
  });
  return setting?.value || process.env.GITHUB_ORG || "michaelbaker-dev";
}

/**
 * Resolve GitHub token for a project.
 * Priority: project token → default token from settings → gh CLI auth (undefined).
 */
export async function resolveGitHubToken(projectId?: string): Promise<string | undefined> {
  // 1. Project-specific token
  if (projectId) {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { githubToken: true },
    });
    if (project?.githubToken) return project.githubToken;
  }
  // 2. Default token from settings
  const defaultToken = await prisma.setting.findUnique({
    where: { key: "github_default_token" },
  });
  if (defaultToken?.value) return defaultToken.value;
  // 3. Fall back to gh CLI auth (return undefined)
  return undefined;
}

async function gh(args: string[], projectId?: string): Promise<string> {
  const token = await resolveGitHubToken(projectId);
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
  const { stdout } = await exec("gh", args, { env });
  return stdout.trim();
}

export async function createRepo(name: string, description: string, projectId?: string) {
  const org = await getOrg();
  return gh(
    [
      "repo",
      "create",
      `${org}/${name}`,
      "--private",
      "--description",
      description,
    ],
    projectId
  );
}

export async function initAndPush(
  repoPath: string,
  repoName: string,
  archProfile: string = "complex",
  projectId?: string
) {
  const org = await getOrg();
  const remoteUrl = `https://github.com/${org}/${repoName}.git`;
  const token = await resolveGitHubToken(projectId);
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

  await exec("git", ["init"], { cwd: repoPath });
  await exec("git", ["add", "."], { cwd: repoPath });
  await exec("git", ["commit", "-m", "chore: initial scaffold"], {
    cwd: repoPath,
  });
  await exec("git", ["branch", "-M", "main"], { cwd: repoPath });
  await exec("git", ["remote", "add", "origin", remoteUrl], {
    cwd: repoPath,
  }).catch(() => {
    // Remote may already exist
  });
  await exec("git", ["push", "-u", "origin", "main"], { cwd: repoPath, env });
  // Only create develop branch for complex projects
  if (archProfile === "complex") {
    await exec("git", ["checkout", "-b", "develop"], { cwd: repoPath });
    await exec("git", ["push", "-u", "origin", "develop"], { cwd: repoPath, env });
    await exec("git", ["checkout", "main"], { cwd: repoPath });
  }
}

/**
 * Clone a repo into the target directory if it's empty, or pull latest if already cloned.
 * Returns true if the repo is ready for analysis.
 */
export async function cloneOrPull(
  repoUrl: string,
  targetPath: string,
  projectId?: string
): Promise<{ cloned: boolean; pulled: boolean; error?: string }> {
  const { existsSync, readdirSync } = await import("fs");

  const token = await resolveGitHubToken(projectId);
  const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

  // Check if already a git repo
  const isGitRepo = existsSync(`${targetPath}/.git`);

  if (isGitRepo) {
    // Pull latest
    try {
      await exec("git", ["pull", "--ff-only"], { cwd: targetPath, env });
      return { cloned: false, pulled: true };
    } catch {
      // Pull failed (diverged, etc.) — still usable for analysis
      return { cloned: false, pulled: false };
    }
  }

  // Check if directory is empty (or nearly empty)
  let isEmpty = true;
  if (existsSync(targetPath)) {
    try {
      const entries = readdirSync(targetPath).filter((e: string) => !e.startsWith("."));
      isEmpty = entries.length === 0;
    } catch {
      isEmpty = true;
    }
  }

  if (isEmpty) {
    // Parse org/repo from URL
    const match = repoUrl.match(/(?:github\.com\/)?([^/]+\/[^/.]+)/);
    if (!match) {
      return { cloned: false, pulled: false, error: `Could not parse repo from: ${repoUrl}` };
    }
    const org = await getOrg();
    const repoSlug = match[1].includes("/") ? match[1] : `${org}/${match[1]}`;

    try {
      await exec("gh", ["repo", "clone", repoSlug, targetPath], { env });
      return { cloned: true, pulled: false };
    } catch (e) {
      return { cloned: false, pulled: false, error: (e as Error).message };
    }
  }

  // Directory has files but no .git — treat as-is
  return { cloned: false, pulled: false };
}

export async function setBranchProtection(repo: string, branch: string, projectId?: string) {
  const org = await getOrg();

  // Use -f flags to pass fields directly
  try {
    await gh(
      [
        "api",
        `repos/${org}/${repo}/branches/${branch}/protection`,
        "-X", "PUT",
        "-H", "Accept: application/vnd.github+json",
        "-f", "required_status_checks[strict]=true",
        "-f", "required_status_checks[contexts][]=ci",
        "-F", "enforce_admins=false",
        "-F", "required_pull_request_reviews[required_approving_review_count]=0",
        "-F", "required_pull_request_reviews[dismiss_stale_reviews]=true",
        "-f", "restrictions=null",
        "-F", "allow_force_pushes=false",
        "-F", "allow_deletions=false",
      ],
      projectId
    );
  } catch {
    console.warn(
      `Branch protection for ${branch} skipped (branch may not exist)`
    );
  }
}

export async function createPR(
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string = "develop",
  projectId?: string
) {
  const org = await getOrg();
  return gh(
    [
      "pr",
      "create",
      "--repo",
      `${org}/${repo}`,
      "--title",
      title,
      "--body",
      body,
      "--head",
      head,
      "--base",
      base,
    ],
    projectId
  );
}

export async function enableAutoMerge(repo: string, prNumber: number, projectId?: string) {
  const org = await getOrg();
  return gh(
    [
      "pr",
      "merge",
      String(prNumber),
      "--repo",
      `${org}/${repo}`,
      "--auto",
      "--squash",
    ],
    projectId
  );
}

export async function getRepoInfo(repo: string, projectId?: string) {
  const org = await getOrg();
  const output = await gh(
    [
      "repo",
      "view",
      `${org}/${repo}`,
      "--json",
      "name,url,defaultBranchRef",
    ],
    projectId
  );
  return JSON.parse(output);
}

export async function deleteRepo(repo: string, projectId?: string) {
  const org = await getOrg();
  return gh(["repo", "delete", `${org}/${repo}`, "--yes"], projectId);
}

/** List open PRs for a repo with metadata */
export interface PullRequestInfo {
  number: number;
  title: string;
  headRefName: string;
  baseRefName: string;
  mergeable: string;
  url: string;
}

export async function listOpenPRs(repo: string, projectId?: string): Promise<PullRequestInfo[]> {
  const org = await getOrg();
  const output = await gh(
    [
      "pr", "list",
      "--repo", `${org}/${repo}`,
      "--state", "open",
      "--json", "number,title,headRefName,baseRefName,mergeable,url",
    ],
    projectId
  );
  return JSON.parse(output) as PullRequestInfo[];
}

/** Fetch a single PR's current status */
export async function getPRInfo(
  repo: string, prNumber: number, projectId?: string
): Promise<PullRequestInfo | null> {
  const org = await getOrg();
  try {
    const output = await gh(
      ["pr", "view", String(prNumber), "--repo", `${org}/${repo}`,
       "--json", "number,title,headRefName,baseRefName,mergeable,url"],
      projectId
    );
    return JSON.parse(output) as PullRequestInfo;
  } catch { return null; }
}

/** Squash-merge a PR by number. Returns true on success. */
export async function mergePR(
  repo: string,
  prNumber: number,
  projectId?: string
): Promise<{ merged: boolean; error?: string }> {
  const org = await getOrg();
  try {
    await gh(
      ["pr", "merge", String(prNumber), "--repo", `${org}/${repo}`, "--squash", "--admin"],
      projectId
    );
    return { merged: true };
  } catch (e) {
    return { merged: false, error: (e as Error).message };
  }
}

/** Close a PR without merging. Optionally delete the head branch. */
export async function closePR(
  repo: string,
  prNumber: number,
  deleteBranch: boolean = true,
  projectId?: string
): Promise<{ closed: boolean; error?: string }> {
  const org = await getOrg();
  try {
    await gh(
      ["pr", "close", String(prNumber), "--repo", `${org}/${repo}`,
       ...(deleteBranch ? ["--delete-branch"] : [])],
      projectId
    );
    return { closed: true };
  } catch (e) {
    return { closed: false, error: (e as Error).message };
  }
}

/** Update a PR's base branch (used when retargeting PRs after merge) */
export async function updatePRBase(
  repo: string,
  prNumber: number,
  newBase: string,
  projectId?: string
): Promise<void> {
  const org = await getOrg();
  await gh(
    [
      "api", `repos/${org}/${repo}/pulls/${prNumber}`,
      "-X", "PATCH",
      "-f", `base=${newBase}`,
    ],
    projectId
  );
}

/** Test gh CLI is authenticated */
export async function testConnection(): Promise<{
  ok: boolean;
  user?: string;
  error?: string;
}> {
  try {
    const output = await gh(["auth", "status"]);
    return { ok: true, user: output };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
