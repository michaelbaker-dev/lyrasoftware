import { prisma } from "@/lib/db";
import ProjectSelector from "@/components/project-selector";

export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: projectId } = await searchParams;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Build project filter
  const projectFilter = projectId ? { projectId } : {};

  // Fetch all data we need in parallel
  const [sessions, allAgents, projects] = await Promise.all([
    prisma.session.findMany({
      where: projectFilter,
      select: {
        id: true,
        ticketKey: true,
        status: true,
        cost: true,
        tokensUsed: true,
        startedAt: true,
        completedAt: true,
        agentId: true,
        project: { select: { name: true } },
        agent: { select: { name: true, model: true } },
      },
    }),
    prisma.agent.findMany({
      where: projectId ? { projectId } : undefined,
      select: { id: true, status: true },
    }),
    prisma.project.findMany({
      select: { id: true, name: true },
    }),
  ]);

  const hasData = sessions.length > 0;

  // --- DORA-like Metrics ---

  // Deployment Frequency: completed sessions per day over last 7 days
  const completedRecent = sessions.filter(
    (s) =>
      s.status === "completed" &&
      s.completedAt &&
      s.completedAt >= sevenDaysAgo,
  );
  const deploymentFrequency =
    completedRecent.length > 0
      ? (completedRecent.length / 7).toFixed(1)
      : "0";

  // Lead Time: average duration (startedAt -> completedAt) for completed sessions
  const completedWithTimes = sessions.filter(
    (s) => s.status === "completed" && s.completedAt && s.startedAt,
  );
  let leadTimeDisplay = "—";
  if (completedWithTimes.length > 0) {
    const totalMs = completedWithTimes.reduce((sum, s) => {
      return sum + (s.completedAt!.getTime() - s.startedAt.getTime());
    }, 0);
    const avgMs = totalMs / completedWithTimes.length;
    const avgMinutes = avgMs / (1000 * 60);
    if (avgMinutes < 60) {
      leadTimeDisplay = `${avgMinutes.toFixed(0)} min`;
    } else {
      leadTimeDisplay = `${(avgMinutes / 60).toFixed(1)} hrs`;
    }
  }

  // Change Failure Rate: failed / (completed + failed)
  const completedCount = sessions.filter(
    (s) => s.status === "completed",
  ).length;
  const failedCount = sessions.filter((s) => s.status === "failed").length;
  const totalFinished = completedCount + failedCount;
  const changeFailureRate =
    totalFinished > 0
      ? ((failedCount / totalFinished) * 100).toFixed(1)
      : "0";

  // Recovery Time: average time for retried sessions
  const byTicket = new Map<
    string,
    { startedAt: Date; completedAt: Date | null; status: string }[]
  >();
  for (const s of sessions) {
    const list = byTicket.get(s.ticketKey) ?? [];
    list.push({
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      status: s.status,
    });
    byTicket.set(s.ticketKey, list);
  }

  let recoveryTimeDisplay = "—";
  const recoveryTimes: number[] = [];
  for (const [, ticketSessions] of byTicket) {
    const sorted = ticketSessions.sort(
      (a, b) => a.startedAt.getTime() - b.startedAt.getTime(),
    );
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].status === "failed") {
        const recovery = sorted
          .slice(i + 1)
          .find((s) => s.status === "completed");
        if (recovery && recovery.completedAt && sorted[i].startedAt) {
          recoveryTimes.push(
            recovery.completedAt.getTime() - sorted[i].startedAt.getTime(),
          );
        }
      }
    }
  }
  if (recoveryTimes.length > 0) {
    const avgRecoveryMs =
      recoveryTimes.reduce((a, b) => a + b, 0) / recoveryTimes.length;
    const avgRecoveryMin = avgRecoveryMs / (1000 * 60);
    if (avgRecoveryMin < 60) {
      recoveryTimeDisplay = `${avgRecoveryMin.toFixed(0)} min`;
    } else {
      recoveryTimeDisplay = `${(avgRecoveryMin / 60).toFixed(1)} hrs`;
    }
  }

  // --- AI Agent Metrics ---
  const agentSuccessRate =
    totalFinished > 0
      ? ((completedCount / totalFinished) * 100).toFixed(0)
      : "—";

  const uniqueTickets = new Set(sessions.map((s) => s.ticketKey));
  const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
  const avgCostPerTicket =
    uniqueTickets.size > 0
      ? `$${(totalCost / uniqueTickets.size).toFixed(2)}`
      : "—";

  let avgRetries = "—";
  if (uniqueTickets.size > 0) {
    const retriedTickets = Array.from(byTicket.values()).filter(
      (s) => s.length > 1,
    ).length;
    avgRetries = (retriedTickets / uniqueTickets.size).toFixed(1);
  }

  const totalAgents = allAgents.length;
  const runningAgents = allAgents.filter((a) => a.status === "running").length;
  const agentUtilization =
    totalAgents > 0
      ? `${((runningAgents / totalAgents) * 100).toFixed(0)}%`
      : "—";

  // --- Cost Breakdown by model ---
  const costByModel = new Map<string, number>();
  for (const s of sessions) {
    const model = s.agent.model ?? "unknown";
    costByModel.set(model, (costByModel.get(model) ?? 0) + s.cost);
  }
  const costBreakdown = Array.from(costByModel.entries())
    .map(([model, cost]) => ({ model, cost }))
    .sort((a, b) => b.cost - a.cost);
  const maxCost = costBreakdown.reduce(
    (max, row) => Math.max(max, row.cost),
    0,
  );

  const doraMetrics = [
    {
      label: "Deployment Frequency",
      value: hasData ? `${deploymentFrequency}/day` : "No data yet",
    },
    {
      label: "Lead Time",
      value: hasData ? leadTimeDisplay : "No data yet",
    },
    {
      label: "Change Failure Rate",
      value: hasData ? `${changeFailureRate}%` : "No data yet",
    },
    {
      label: "Recovery Time",
      value: hasData ? recoveryTimeDisplay : "No data yet",
    },
  ];

  const aiMetrics = [
    {
      label: "Agent Success Rate",
      value: hasData ? `${agentSuccessRate}%` : "—",
    },
    { label: "Auto-Merge Rate", value: "—" },
    { label: "Avg Cost/Ticket", value: hasData ? avgCostPerTicket : "—" },
    { label: "Tokens/Story Point", value: "—" },
    { label: "Avg Retries", value: hasData ? avgRetries : "—" },
    { label: "Agent Utilization", value: agentUtilization },
  ];

  const selectedProject = projectId
    ? projects.find((p) => p.id === projectId)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">DORA Metrics</h1>
          {selectedProject && (
            <p className="text-sm text-gray-400 mt-1">
              Filtered to: {selectedProject.name}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <ProjectSelector projects={projects} />
          <select className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm">
            <option>Last 7 days</option>
            <option>Last 30 days</option>
            <option>Last 90 days</option>
          </select>
        </div>
      </div>

      {/* DORA Metrics Grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
        {doraMetrics.map((metric) => (
          <div
            key={metric.label}
            className="rounded-xl border border-gray-800 bg-gray-900 p-5"
          >
            <div className="text-sm text-gray-400">{metric.label}</div>
            <div className="mt-1 text-2xl font-bold">{metric.value}</div>
          </div>
        ))}
      </div>

      {/* AI-Specific Metrics */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">AI Agent Metrics</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          {aiMetrics.map((m) => (
            <div key={m.label}>
              <div className="text-xs text-gray-500">{m.label}</div>
              <div className="mt-1 text-lg font-semibold">{m.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Velocity Chart Placeholder */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Velocity</h2>
        <div className="flex h-48 items-center justify-center text-gray-500">
          {hasData
            ? "Chart will be rendered here with DuckDB-powered analytics"
            : "No session data yet — velocity chart will appear once agents complete work"}
        </div>
      </div>

      {/* Cost Breakdown */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Cost Breakdown</h2>
        {costBreakdown.length > 0 ? (
          <div className="space-y-3">
            {costBreakdown.map((row) => (
              <div key={row.model} className="flex items-center gap-4">
                <div className="w-40 text-sm">{row.model}</div>
                <div className="flex-1">
                  <div className="h-2 rounded-full bg-gray-800">
                    <div
                      className="h-2 rounded-full bg-blue-600"
                      style={{
                        width: `${maxCost > 0 ? (row.cost / maxCost) * 100 : 0}%`,
                      }}
                    />
                  </div>
                </div>
                <div className="w-20 text-right text-sm text-gray-400">
                  ${row.cost.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-20 items-center justify-center text-gray-500">
            No cost data yet
          </div>
        )}
      </div>
    </div>
  );
}
