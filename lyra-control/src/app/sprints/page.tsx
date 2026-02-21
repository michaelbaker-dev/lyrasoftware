import { prisma } from "@/lib/db";
import Link from "next/link";
import SprintManager from "./sprint-manager";
import ProjectSelector from "@/components/project-selector";
import { updateSprintProgress } from "@/lib/sprint-planner";

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

      {projects.map((project) => (
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
          />
        </div>
      ))}
    </div>
  );
}
