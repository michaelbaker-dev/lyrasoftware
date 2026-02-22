import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import DeleteButton from "./delete-button";
import ChatPanel from "./chat-panel";
import TeamConfig from "./team-config";
import UnassignedAgents from "./unassigned-agents";
import SessionList from "./session-list";
import SlackChannelStatus from "./slack-channel-status";

export default async function ProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const project = await prisma.project.findUnique({
    where: { id },
    include: {
      agents: true,
      teams: {
        include: { agents: true },
        orderBy: { routingPriority: "asc" },
      },
      sessions: {
        orderBy: { startedAt: "desc" },
        take: 50,
        include: {
          agent: true,
          _count: { select: { gateRuns: true } },
        },
      },
    },
  });

  if (!project) {
    notFound();
  }

  // Fetch project cost totals
  const costAgg = await prisma.aiUsageLog.aggregate({
    where: { projectId: id },
    _sum: { cost: true, totalTokens: true },
    _count: true,
  });
  const sessionCostAgg = await prisma.session.aggregate({
    where: { projectId: id },
    _sum: { cost: true },
  });
  const totalCost = (costAgg._sum.cost ?? 0) + (sessionCostAgg._sum.cost ?? 0);
  const totalTokens = costAgg._sum.totalTokens ?? 0;
  const aiCalls = costAgg._count;

  function formatCost(cost: number): string {
    if (cost < 0.01) return cost > 0 ? "<$0.01" : "$0.00";
    return `$${cost.toFixed(2)}`;
  }

  const statusColor: Record<string, string> = {
    active: "text-green-400",
    paused: "text-yellow-400",
    archived: "text-gray-500",
  };

  const docStatusColor: Record<string, string> = {
    pending: "text-gray-500",
    generating: "text-yellow-400",
    review: "text-blue-400",
    approved: "text-green-400",
  };

  function formatDate(date: Date | null | undefined): string {
    if (!date) return "\u2014";
    return new Date(date).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{project.name}</h1>
        <div className="flex items-center gap-3">
          <span
            className={`text-sm font-medium ${statusColor[project.status] ?? "text-gray-400"}`}
          >
            {project.status}
          </span>
          <DeleteButton
            projectId={project.id}
            projectName={project.name}
            jiraKey={project.jiraKey}
            githubRepo={project.githubRepo}
            existingRepo={project.existingRepo}
          />
        </div>
      </div>

      {/* Project Info */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Project Details</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4 text-sm">
          <div>
            <dt className="text-gray-500">Jira Key</dt>
            <dd className="mt-0.5 font-medium text-blue-400">
              {project.jiraKey}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">GitHub Repo</dt>
            <dd className="mt-0.5 font-medium text-gray-200">
              {project.githubRepo ?? "\u2014"}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Tech Stack</dt>
            <dd className="mt-0.5 font-medium text-gray-200">
              {project.techStack ?? "\u2014"}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Status</dt>
            <dd
              className={`mt-0.5 font-medium ${statusColor[project.status] ?? "text-gray-400"}`}
            >
              {project.status}
            </dd>
          </div>
        </dl>
        {/* Cost Summary */}
        <div className="mt-4 flex items-center gap-6 rounded-lg bg-gray-800/50 px-4 py-3 text-sm">
          <div>
            <span className="text-gray-500">Total Cost: </span>
            <span className="font-semibold text-white">{formatCost(totalCost)}</span>
          </div>
          <div>
            <span className="text-gray-500">Tokens: </span>
            <span className="text-gray-300">{totalTokens.toLocaleString()}</span>
          </div>
          <div>
            <span className="text-gray-500">AI Calls: </span>
            <span className="text-gray-300">{aiCalls}</span>
          </div>
        </div>
        {project.vision && (
          <div className="mt-4">
            <h3 className="text-sm font-medium text-gray-500 mb-1">Vision</h3>
            <p className="text-sm text-gray-400 whitespace-pre-line">{project.vision}</p>
          </div>
        )}
        {!project.vision && project.description && (
          <p className="mt-4 text-sm text-gray-400">{project.description}</p>
        )}
      </div>

      {/* PRD & ARD */}
      {(project.prdContent || project.ardContent) && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="mb-4 text-lg font-semibold">Architecture Documents</h2>
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <span className="text-sm text-gray-500">PRD Status: </span>
              <span className={`text-sm font-medium ${docStatusColor[project.prdStatus] ?? "text-gray-400"}`}>
                {project.prdStatus}
              </span>
            </div>
            <div>
              <span className="text-sm text-gray-500">ARD Status: </span>
              <span className={`text-sm font-medium ${docStatusColor[project.ardStatus] ?? "text-gray-400"}`}>
                {project.ardStatus}
              </span>
            </div>
          </div>
          {project.prdContent && (
            <details className="mb-4">
              <summary className="cursor-pointer text-sm font-medium text-gray-300 hover:text-gray-100">
                PRD — Product Requirements Document
              </summary>
              <pre className="mt-2 text-sm text-gray-400 whitespace-pre-wrap font-mono bg-gray-800 rounded-lg p-4 overflow-x-auto">
                {project.prdContent}
              </pre>
            </details>
          )}
          {project.ardContent && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-gray-300 hover:text-gray-100">
                ARD — Architecture Decision Record
              </summary>
              <pre className="mt-2 text-sm text-gray-400 whitespace-pre-wrap font-mono bg-gray-800 rounded-lg p-4 overflow-x-auto">
                {project.ardContent}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Team Configuration */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <TeamConfig
          projectId={project.id}
          teams={project.teams.map((team) => ({
            id: team.id,
            name: team.name,
            specialization: team.specialization,
            model: team.model,
            systemPrompt: team.systemPrompt,
            routingLabels: team.routingLabels,
            routingPriority: team.routingPriority,
            isDefault: team.isDefault,
            enabled: team.enabled,
            maxAgents: team.maxAgents,
            agents: team.agents.map((agent) => ({
              id: agent.id,
              name: agent.name,
              role: agent.role,
              model: agent.model,
              personality: agent.personality,
              status: agent.status,
              currentTicket: agent.currentTicket,
            })),
          }))}
        />

        <UnassignedAgents
          agents={project.agents
            .filter((a) => !a.teamId)
            .map((a) => ({
              id: a.id,
              name: a.name,
              role: a.role,
              status: a.status,
              currentTicket: a.currentTicket,
            }))}
        />
      </div>

      {/* Recent Sessions */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <SessionList
          sessions={project.sessions.map((s) => ({
            id: s.id,
            ticketKey: s.ticketKey,
            branch: s.branch,
            status: s.status,
            cost: s.cost,
            startedAt: s.startedAt.toISOString(),
            completedAt: s.completedAt?.toISOString() ?? null,
            agent: { id: s.agent.id, name: s.agent.name, role: s.agent.role },
            _count: { gateRuns: (s as unknown as { _count: { gateRuns: number } })._count.gateRuns },
          }))}
        />
      </div>

      {/* Per-Project Channels */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Channels</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-3 text-sm">
          <SlackChannelStatus
            projectId={project.id}
            channelId={project.slackChannelId}
            jiraKey={project.jiraKey}
          />
          <div>
            <dt className="text-gray-500">Webhook URL</dt>
            <dd className="mt-0.5 font-medium text-gray-400 truncate max-w-xs">
              {project.webhookUrl || <span className="text-gray-600">Global default</span>}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">Email Thread</dt>
            <dd className="mt-0.5 font-medium text-gray-400">
              [{project.emailThreadPrefix || project.jiraKey}]
            </dd>
          </div>
        </dl>
      </div>

      {/* Spacer for fixed chat panel */}
      <div className="h-16" />

      {/* Chat Panel */}
      <ChatPanel projectId={id} />
    </div>
  );
}
