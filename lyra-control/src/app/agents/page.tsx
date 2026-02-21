import { prisma } from "@/lib/db";
import { getState } from "@/lib/dispatcher";
import { DispatcherControls } from "./dispatcher-controls";
import { LiveAgents } from "./live-agents";

const statusColors: Record<string, string> = {
  idle: "bg-gray-600",
  running: "bg-green-500",
  errored: "bg-red-500",
  "rate-limited": "bg-yellow-500",
};

const roleColors: Record<string, string> = {
  architect: "text-amber-400",
  dev: "text-blue-400",
  qa: "text-yellow-400",
};

function formatCost(cost: number): string {
  if (cost < 0.01) return cost > 0 ? "<$0.01" : "$0.00";
  return `$${cost.toFixed(2)}`;
}

export default async function AgentsPage() {
  // Fetch agents with team, project, and session data
  const agents = await prisma.agent.findMany({
    include: {
      project: true,
      team: true,
      sessions: {
        select: { status: true, cost: true },
      },
    },
    orderBy: [{ projectId: "asc" }, { teamId: "asc" }, { createdAt: "asc" }],
  });

  // Fetch per-project cost totals from AiUsageLog
  const projectCosts = await prisma.aiUsageLog.groupBy({
    by: ["projectId"],
    _sum: { cost: true },
    where: { projectId: { not: null } },
  });
  const projectCostMap = new Map(
    projectCosts.map((pc) => [pc.projectId, pc._sum.cost ?? 0])
  );

  // Group agents by project
  const projectGroups = new Map<
    string | null,
    {
      projectId: string | null;
      projectName: string;
      jiraKey: string | null;
      totalCost: number;
      agents: typeof agentsWithStats;
    }
  >();

  const agentsWithStats = agents.map((agent) => {
    const completedSessions = agent.sessions.filter(
      (s) => s.status === "completed" || s.status === "failed"
    );
    const successfulSessions = agent.sessions.filter(
      (s) => s.status === "completed"
    );
    const sessionsCompleted = completedSessions.length;
    const successRate =
      sessionsCompleted > 0
        ? Math.round((successfulSessions.length / sessionsCompleted) * 100)
        : 0;
    const agentCost = agent.sessions.reduce(
      (sum, s) => sum + (s.cost ?? 0),
      0
    );
    const resolvedModel =
      agent.model ?? agent.team?.model ?? "claude-sonnet-4-5";

    return {
      id: agent.id,
      name: agent.name,
      role: agent.role,
      resolvedModel,
      modelInherited: !agent.model,
      status: agent.status as "idle" | "running" | "errored" | "rate-limited",
      projectId: agent.projectId,
      projectName: agent.project?.name ?? null,
      jiraKey: agent.project?.jiraKey ?? null,
      teamName: agent.team?.name ?? null,
      teamSpecialization: agent.team?.specialization ?? null,
      currentTicket: agent.currentTicket,
      sessionsCompleted,
      successRate,
      agentCost,
    };
  });

  // Build project groups
  for (const agent of agentsWithStats) {
    const key = agent.projectId ?? "__unassigned__";
    if (!projectGroups.has(key)) {
      projectGroups.set(key, {
        projectId: agent.projectId,
        projectName: agent.projectName ?? "Unassigned",
        jiraKey: agent.jiraKey,
        totalCost: agent.projectId
          ? projectCostMap.get(agent.projectId) ?? 0
          : 0,
        agents: [],
      });
    }
    projectGroups.get(key)!.agents.push(agent);
  }

  const dispatcherState = getState();
  const groups = Array.from(projectGroups.values());

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Agents</h1>

      <LiveAgents />

      {groups.length === 0 ? (
        <div className="rounded-xl border border-gray-800 bg-gray-900 px-5 py-10 text-center text-gray-400">
          No agents configured
        </div>
      ) : (
        groups.map((group) => (
          <div
            key={group.projectId ?? "unassigned"}
            className="rounded-xl border border-gray-800 bg-gray-900"
          >
            {/* Project Header */}
            <div className="flex items-center justify-between border-b border-gray-800 px-5 py-3">
              <div className="flex items-center gap-3">
                <h2 className="font-semibold text-gray-200">
                  {group.projectName}
                </h2>
                {group.jiraKey && (
                  <span className="text-xs px-2 py-0.5 rounded bg-gray-800 text-gray-500 border border-gray-700">
                    {group.jiraKey}
                  </span>
                )}
                <span className="text-xs text-gray-500">
                  {group.agents.length} agent{group.agents.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="flex items-center gap-4 text-xs">
                <span className="text-gray-500">
                  {group.agents.filter((a) => a.status === "running").length} running
                </span>
                <span className="text-gray-400 font-medium">
                  Total cost: {formatCost(group.totalCost)}
                </span>
              </div>
            </div>

            {/* Agents Table */}
            <table className="w-full">
              <thead>
                <tr className="border-b border-gray-800/50 text-left text-xs text-gray-500">
                  <th className="px-5 py-2">Agent</th>
                  <th className="px-5 py-2">Role</th>
                  <th className="px-5 py-2">Team</th>
                  <th className="px-5 py-2">Model</th>
                  <th className="px-5 py-2">Status</th>
                  <th className="px-5 py-2">Ticket</th>
                  <th className="px-5 py-2">Sessions</th>
                  <th className="px-5 py-2">Success</th>
                  <th className="px-5 py-2 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {group.agents.map((agent) => (
                  <tr
                    key={agent.id}
                    className="border-b border-gray-800/30 text-sm hover:bg-gray-800/30"
                  >
                    <td className="px-5 py-2.5 font-medium text-gray-200">
                      {agent.name}
                    </td>
                    <td className="px-5 py-2.5">
                      <span className={roleColors[agent.role] ?? "text-gray-400"}>
                        {agent.role}
                      </span>
                    </td>
                    <td className="px-5 py-2.5">
                      {agent.teamName ? (
                        <span className="text-gray-300">
                          {agent.teamName}
                          {agent.teamSpecialization && (
                            <span className="text-gray-600 ml-1 text-xs">
                              ({agent.teamSpecialization})
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="text-gray-600">&mdash;</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-xs">
                      <span className="text-gray-400">
                        {agent.resolvedModel}
                      </span>
                      {agent.modelInherited && (
                        <span className="text-gray-600 ml-1">(team)</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5">
                      <span className="inline-flex items-center gap-1.5">
                        <span
                          className={`h-2 w-2 rounded-full ${statusColors[agent.status] ?? "bg-gray-600"}`}
                        />
                        <span className="text-gray-300">{agent.status}</span>
                      </span>
                    </td>
                    <td className="px-5 py-2.5">
                      {agent.currentTicket ? (
                        <span className="text-blue-400">{agent.currentTicket}</span>
                      ) : (
                        <span className="text-gray-600">&mdash;</span>
                      )}
                    </td>
                    <td className="px-5 py-2.5 text-gray-400">
                      {agent.sessionsCompleted}
                    </td>
                    <td className="px-5 py-2.5 text-gray-400">
                      {agent.sessionsCompleted > 0 ? `${agent.successRate}%` : "\u2014"}
                    </td>
                    <td className="px-5 py-2.5 text-right text-gray-400">
                      {agent.agentCost > 0 ? formatCost(agent.agentCost) : "\u2014"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {/* Dispatcher Controls */}
      <DispatcherControls
        initialState={{
          running: dispatcherState.running,
          pollInterval: dispatcherState.pollInterval,
          messagesUsed: dispatcherState.messagesUsed,
          messageLimit: dispatcherState.messageLimit,
          activeAgentCount: dispatcherState.activeAgentCount,
        }}
      />
    </div>
  );
}
