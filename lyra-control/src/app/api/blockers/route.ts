import { prisma } from "@/lib/db";
import { transitionIssue, getTransitions, getIssue, extractDependencies } from "@/lib/jira";
import { resolveGitHubToken } from "@/lib/github";
import { triggerDispatch } from "@/lib/dispatcher";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export async function GET(request: Request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");

  // Section 1: Abandoned tickets (hit max retries, no completed session)
  const allFailed = await prisma.session.groupBy({
    by: ["ticketKey", "projectId"],
    where: {
      status: "failed",
      ...(projectId ? { projectId } : {}),
    },
    _count: { id: true },
    having: { id: { _count: { gte: 5 } } },
  });

  const abandonedTickets: Array<{
    ticketKey: string;
    projectId: string;
    failureCount: number;
    lastOutput: string;
    lastGateFailure: string;
    blockedDependents: string[];
  }> = [];

  for (const group of allFailed) {
    // Check if there's a completed session for this ticket
    const completed = await prisma.session.findFirst({
      where: { ticketKey: group.ticketKey, projectId: group.projectId, status: "completed" },
    });
    if (completed) continue;

    const lastFailed = await prisma.session.findFirst({
      where: { ticketKey: group.ticketKey, projectId: group.projectId, status: "failed" },
      orderBy: { completedAt: "desc" },
      select: { output: true },
    });

    const lastGate = await prisma.qualityGateRun.findFirst({
      where: { ticketKey: group.ticketKey, projectId: group.projectId, passed: false },
      orderBy: { createdAt: "desc" },
      select: { reasoning: true },
    });

    // Find which tickets this abandoned ticket blocks
    let blockedDependents: string[] = [];
    try {
      const issue = await getIssue(group.ticketKey);
      const deps = extractDependencies(issue);
      blockedDependents = deps
        .filter((d) => d.type === "blocks")
        .map((d) => d.key);
    } catch {
      // Jira fetch failed — skip dependents lookup
    }

    abandonedTickets.push({
      ticketKey: group.ticketKey,
      projectId: group.projectId,
      failureCount: group._count.id,
      lastOutput: (lastFailed?.output || "").slice(-200),
      lastGateFailure: lastGate?.reasoning || "",
      blockedDependents,
    });
  }

  // Section 2: Recent gate failures (no subsequent pass)
  const recentGateFailures = await prisma.qualityGateRun.findMany({
    where: {
      passed: false,
      createdAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      ...(projectId ? { projectId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  const gateFailures: Array<{
    id: string;
    ticketKey: string;
    projectId: string;
    checks: string;
    reasoning: string;
    createdAt: string;
  }> = [];

  for (const gf of recentGateFailures) {
    // Check if there's a subsequent passing gate
    const subsequentPass = await prisma.qualityGateRun.findFirst({
      where: {
        ticketKey: gf.ticketKey,
        projectId: gf.projectId,
        passed: true,
        createdAt: { gt: gf.createdAt },
      },
    });
    if (subsequentPass) continue;

    // Avoid duplicates
    if (gateFailures.some((g) => g.ticketKey === gf.ticketKey)) continue;

    gateFailures.push({
      id: gf.id,
      ticketKey: gf.ticketKey,
      projectId: gf.projectId,
      checks: gf.checks,
      reasoning: gf.reasoning,
      createdAt: gf.createdAt.toISOString(),
    });
  }

  // Section 3: Open PRs not merged
  const projects = await prisma.project.findMany({
    where: {
      status: "active",
      githubRepo: { not: null },
      ...(projectId ? { id: projectId } : {}),
    },
    select: { id: true, githubRepo: true },
  });

  const openPrs: Array<{
    projectId: string;
    repo: string;
    number: number;
    title: string;
    branch: string;
    url: string;
    createdAt: string;
  }> = [];

  const org = (await prisma.setting.findUnique({ where: { key: "github_org" } }))?.value || "michaelbaker-dev";

  for (const proj of projects) {
    if (!proj.githubRepo) continue;
    try {
      const token = await resolveGitHubToken(proj.id);
      const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
      const { stdout } = await exec("gh", [
        "pr", "list", "--repo", `${org}/${proj.githubRepo}`,
        "--state", "open", "--json", "number,title,headRefName,url,createdAt",
      ], { env });
      const prs = JSON.parse(stdout);
      for (const pr of prs) {
        openPrs.push({
          projectId: proj.id,
          repo: proj.githubRepo,
          number: pr.number,
          title: pr.title,
          branch: pr.headRefName,
          url: pr.url,
          createdAt: pr.createdAt,
        });
      }
    } catch {
      // GitHub query failed — skip
    }
  }

  return Response.json({ abandonedTickets, gateFailures, openPrs });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { action } = body;

  try {
    switch (action) {
      case "retry": {
        const { ticketKey, projectId } = body;
        if (!ticketKey || !projectId) {
          return Response.json({ error: "ticketKey and projectId are required" }, { status: 400 });
        }

        // Delete all failed sessions for the ticket
        await prisma.session.deleteMany({
          where: { ticketKey, projectId, status: "failed" },
        });

        // Transition Jira ticket to "To Do"
        try {
          const { transitions } = await getTransitions(ticketKey);
          const toDo = transitions?.find(
            (t: { name: string }) =>
              t.name.toLowerCase() === "to do" || t.name.toLowerCase().includes("to do")
          );
          if (toDo) {
            await transitionIssue(ticketKey, toDo.id);
          }
        } catch {
          // Jira transition failed — continue anyway
        }

        // Trigger dispatch to pick up the ticket
        triggerDispatch();

        return Response.json({ success: true });
      }

      case "merge": {
        const { repo, prNumber, projectId } = body;
        if (!repo || !prNumber) {
          return Response.json({ error: "repo and prNumber are required" }, { status: 400 });
        }

        const org = (await prisma.setting.findUnique({ where: { key: "github_org" } }))?.value || "michaelbaker-dev";
        const token = await resolveGitHubToken(projectId);
        const env = token ? { ...process.env, GH_TOKEN: token } : process.env;

        await exec("gh", [
          "pr", "merge", String(prNumber),
          "--repo", `${org}/${repo}`,
          "--squash",
        ], { env });

        return Response.json({ success: true });
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
