/**
 * Shared demo data gathering — extracted from sprints route.
 * Used by both the "demo" action and "release-notes" action.
 */

import { prisma } from "@/lib/db";
import { resolveGitHubToken } from "@/lib/github";
import { execFile } from "child_process";
import { promisify } from "util";

const exec = promisify(execFile);

export type DemoTicket = {
  key: string;
  summary: string;
  status: "completed" | "failed";
  gatePassed: boolean | null;
  gateReasoning: string;
  prUrl: string | null;
  prState: string | null;
  agent: string;
  cost: number;
};

export type DemoData = {
  tickets: DemoTicket[];
  project: { path: string; repo: string | null; runCmd: string; name: string };
  totals: {
    completed: number;
    failed: number;
    cost: number;
    gatePassRate: number;
  };
  openPrCount: number;
};

export async function gatherDemoData(
  projectId: string,
  sprintId: string
): Promise<DemoData> {
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint) throw new Error("Sprint not found");

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("Project not found");

  // Get sessions within sprint date range (or all if no dates)
  const sessionWhere: Record<string, unknown> = { projectId };
  if (sprint.startDate && sprint.endDate) {
    sessionWhere.startedAt = { gte: sprint.startDate, lte: sprint.endDate };
  }
  const sessions = await prisma.session.findMany({
    where: sessionWhere,
    include: { agent: { select: { name: true } } },
    orderBy: { startedAt: "asc" },
  });

  // Get quality gate results for each ticket
  const ticketKeys = [...new Set(sessions.map((s) => s.ticketKey))];
  const gateRuns = await prisma.qualityGateRun.findMany({
    where: { ticketKey: { in: ticketKeys }, projectId },
    orderBy: { createdAt: "desc" },
  });

  // Get PR status from GitHub
  let prs: Array<{
    number: number;
    title: string;
    url: string;
    state: string;
    headRefName: string;
  }> = [];
  if (project.githubRepo) {
    try {
      const token = await resolveGitHubToken(projectId);
      const env = token ? { ...process.env, GH_TOKEN: token } : process.env;
      const org =
        (await prisma.setting.findUnique({ where: { key: "github_org" } }))
          ?.value || "michaelbaker-dev";
      const { stdout } = await exec(
        "gh",
        [
          "pr",
          "list",
          "--repo",
          `${org}/${project.githubRepo}`,
          "--state",
          "all",
          "--limit",
          "100",
          "--json",
          "number,title,url,state,headRefName",
        ],
        { env }
      );
      prs = JSON.parse(stdout);
    } catch {
      // GitHub query failed — continue without PR data
    }
  }

  // Build ticket outcomes
  const tickets: DemoTicket[] = ticketKeys.map((key) => {
    const keySessions = sessions.filter((s) => s.ticketKey === key);
    const latestSession = keySessions[keySessions.length - 1];
    const completed = keySessions.some((s) => s.status === "completed");
    const latestGate = gateRuns.find((g) => g.ticketKey === key);
    const matchingPr = prs.find((p) => p.headRefName.includes(key));

    return {
      key,
      summary: key,
      status: completed ? ("completed" as const) : ("failed" as const),
      gatePassed: latestGate?.passed ?? null,
      gateReasoning: latestGate?.reasoning ?? "",
      prUrl: matchingPr?.url ?? null,
      prState: matchingPr?.state ?? null,
      agent: latestSession?.agent?.name ?? "unknown",
      cost: keySessions.reduce((sum, s) => sum + s.cost, 0),
    };
  });

  const openPrCount = prs.filter((p) => p.state === "OPEN").length;

  // Parse project run command
  let runCmd = "npm run dev";
  try {
    const { readFileSync: rfs } = await import("fs");
    const pkg = JSON.parse(rfs(`${project.path}/package.json`, "utf-8"));
    if (pkg.scripts?.dev) runCmd = `npm run dev`;
    else if (pkg.scripts?.start) runCmd = `npm start`;
  } catch {
    /* fallback */
  }

  const totals = {
    completed: tickets.filter((t) => t.status === "completed").length,
    failed: tickets.filter((t) => t.status === "failed").length,
    cost: tickets.reduce((s, t) => s + t.cost, 0),
    gatePassRate:
      tickets.length > 0
        ? Math.round(
            (tickets.filter((t) => t.gatePassed).length / tickets.length) * 100
          )
        : 0,
  };

  return {
    tickets,
    project: {
      path: project.path,
      repo: project.githubRepo,
      runCmd,
      name: project.name,
    },
    totals,
    openPrCount,
  };
}
