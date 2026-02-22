import Link from "next/link";
import { prisma } from "@/lib/db";
import DeleteButton from "./[id]/delete-button";

const healthColors = {
  green: "bg-green-500",
  yellow: "bg-yellow-500",
  red: "bg-red-500",
};

type Health = keyof typeof healthColors;

function deriveHealth(
  projectStatus: string,
  erroredAgentCount: number
): Health {
  if (projectStatus !== "active") return "red";
  if (erroredAgentCount > 0) return "yellow";
  return "green";
}

export default async function ProjectsPage() {
  const projects = await prisma.project.findMany({
    include: {
      agents: {
        select: { id: true, status: true },
      },
      sessions: {
        select: { id: true, status: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const projectCards = projects.map((project) => {
    const activeAgents = project.agents.filter(
      (a) => a.status === "running"
    ).length;
    const openSessions = project.sessions.filter(
      (s) => s.status === "running"
    ).length;
    const erroredAgents = project.agents.filter(
      (a) => a.status === "errored"
    ).length;
    const health = deriveHealth(project.status, erroredAgents);

    return {
      id: project.id,
      name: project.name,
      jiraKey: project.jiraKey,
      githubRepo: project.githubRepo,
      existingRepo: project.existingRepo,
      health,
      openSessions,
      activeAgents,
    };
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Link
          href="/onboarding"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
        >
          + New Project
        </Link>
      </div>

      {projectCards.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-10 text-center">
          <p className="text-gray-400">No projects yet.</p>
          <Link
            href="/onboarding"
            className="mt-3 inline-block text-sm font-medium text-blue-400 hover:text-blue-300"
          >
            Create your first project
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projectCards.map((project) => (
            <div
              key={project.id}
              className="relative rounded-xl border border-gray-800 bg-gray-900 p-5 transition-colors hover:border-gray-700"
            >
              <Link
                href={`/projects/${project.id}`}
                className="block"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`h-3 w-3 rounded-full ${healthColors[project.health]}`}
                  />
                  <h3 className="font-semibold">{project.name}</h3>
                </div>
                <div className="mt-3 space-y-1 text-sm text-gray-400">
                  <div>Jira: {project.jiraKey}</div>
                  {project.githubRepo && (
                    <div>Repo: {project.githubRepo}</div>
                  )}
                  <div className="flex gap-4 pt-2">
                    <span>{project.openSessions} open tickets</span>
                    <span>{project.activeAgents} active agents</span>
                  </div>
                </div>
              </Link>
              <div className="absolute top-3 right-3">
                <DeleteButton
                  projectId={project.id}
                  projectName={project.name}
                  jiraKey={project.jiraKey}
                  githubRepo={project.githubRepo}
                  existingRepo={project.existingRepo}
                  compact
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
