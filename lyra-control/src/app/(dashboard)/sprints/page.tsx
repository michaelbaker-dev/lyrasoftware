import { prisma } from "@/lib/db";
import Link from "next/link";
import SprintManager from "./sprint-manager";
import ProjectSelector from "@/components/project-selector";
import { updateSprintProgress } from "@/lib/sprint-planner";
import { type WorkBreakdown, countStories } from "@/lib/work-breakdown";
import { getSprintIssues, getStoryPointsFieldId, extractDependencies } from "@/lib/jira";
import { getState as getDispatcherState } from "@/lib/dispatcher";

export type SprintTicket = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  points: number;
  issuetype: string;
  hasRunningAgent: boolean;
  blockedBy: string[];
};

async function fetchSprintTickets(activeSprintId: number): Promise<SprintTicket[]> {
  try {
    const [sprintData, spFieldId] = await Promise.all([
      getSprintIssues(activeSprintId),
      getStoryPointsFieldId(),
    ]);
    const issues = sprintData?.issues || [];
    const dispatcherState = getDispatcherState();
    const activeTicketKeys = new Set(dispatcherState.agents.map((a) => a.ticketKey));

    return issues
      .filter((issue: { fields: { issuetype?: { name: string } } }) => {
        const typeName = issue.fields?.issuetype?.name || "";
        return typeName !== "Epic";
      })
      .map((issue: { key: string; fields: Record<string, unknown> }) => {
        const fields = issue.fields;
        const statusObj = fields.status as { name: string; statusCategory?: { key: string } } | undefined;
        const deps = extractDependencies(issue as Parameters<typeof extractDependencies>[0]);
        const blockers = deps
          .filter((d) => d.type === "is-blocked-by" && d.status !== "done")
          .map((d) => d.key);

        return {
          key: issue.key,
          summary: (fields.summary as string) || "",
          status: statusObj?.name || "Unknown",
          statusCategory: statusObj?.statusCategory?.key || "new",
          points: spFieldId ? (Number(fields[spFieldId]) || 0) : 0,
          issuetype: (fields.issuetype as { name: string })?.name || "Story",
          hasRunningAgent: activeTicketKeys.has(issue.key),
          blockedBy: blockers,
        };
      });
  } catch (e) {
    console.error("[SprintsPage] Failed to fetch sprint tickets:", e);
    return [];
  }
}

export default async function SprintsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: projectId } = await searchParams;

  const allProjects = await prisma.project.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
  });

  // Refresh sprint progress from Jira before rendering so counts are never stale.
  // This is lightweight (one Jira query per active project with a sprint).
  const activeProjects = await prisma.project.findMany({
    where: {
      status: "active",
      activeSprintId: { not: null },
      ...(projectId ? { id: projectId } : {}),
    },
    select: { id: true },
  });
  await Promise.all(
    activeProjects.map((p) => updateSprintProgress(p.id).catch(() => { /* non-fatal */ }))
  );

  const projects = await prisma.project.findMany({
    where: {
      status: "active",
      ...(projectId ? { id: projectId } : {}),
    },
    include: {
      sprints: { orderBy: { createdAt: "desc" } },
    },
  });

  if (projects.length === 0) {
    return (
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Sprint Planning</h1>
          <ProjectSelector projects={allProjects} />
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-8 text-center">
          <p className="text-gray-400">No active projects found.</p>
          <Link href="/onboarding" className="mt-3 inline-block text-blue-400 hover:text-blue-300">
            Onboard a project to get started
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Sprint Planning</h1>
        <ProjectSelector projects={allProjects} />
      </div>

      {await Promise.all(projects.map(async (project) => {
        const sprintTickets = project.activeSprintId
          ? await fetchSprintTickets(project.activeSprintId)
          : [];

        return (
          <div key={project.id} className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">{project.name}</h2>
                <p className="text-sm text-gray-400">
                  {project.jiraKey} &middot; Velocity target: {project.velocityTarget} pts &middot; Sprint length: {project.sprintLength} days
                </p>
              </div>
            </div>

            <SprintManager
              projectId={project.id}
              projectName={project.name}
              jiraKey={project.jiraKey}
              velocityTarget={project.velocityTarget}
              sprintLength={project.sprintLength}
              activeSprintId={project.activeSprintId}
              breakdownReady={project.breakdownStatus === "approved" && !!project.breakdownContent}
              breakdownStoryCount={
                project.breakdownStatus === "approved" && project.breakdownContent
                  ? (() => { try { return countStories(JSON.parse(project.breakdownContent) as WorkBreakdown); } catch { return 0; } })()
                  : 0
              }
              initialSprints={project.sprints.map((s) => ({
                id: s.id,
                name: s.name,
                goal: s.goal,
                state: s.state,
                plannedPoints: s.plannedPoints,
                completedPoints: s.completedPoints,
                startDate: s.startDate?.toISOString() || null,
                endDate: s.endDate?.toISOString() || null,
              }))}
              initialTickets={sprintTickets}
            />
          </div>
        );
      }))}
    </div>
  );
}
