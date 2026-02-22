import { prisma } from "@/lib/db";
import { getCurrentBurnRate, projectToSprintEnd, getDailyCostSeries } from "@/lib/cost-projections";
import ProjectSelector from "@/components/project-selector";
import DateRangeSelector from "./date-range-selector";

const RANGE_DAYS: Record<string, number> = {
  "7d": 7,
  "14d": 14,
  "30d": 30,
};

export default async function MetricsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string; range?: string }>;
}) {
  const { project: projectId, range: rangeParam } = await searchParams;
  const now = new Date();

  // Resolve date range — default to 7 days
  let rangeDays = RANGE_DAYS[rangeParam || "7d"] || 7;
  let rangeLabel = rangeParam || "7d";

  // Handle "sprint" range — use active sprint dates
  let sprintRangeStart: Date | null = null;
  if (rangeParam === "sprint") {
    const activeSprint = projectId
      ? await prisma.sprint.findFirst({ where: { project: { id: projectId }, state: "active" } })
      : await prisma.sprint.findFirst({ where: { state: "active" } });
    if (activeSprint?.startDate) {
      sprintRangeStart = activeSprint.startDate;
      rangeDays = Math.ceil((now.getTime() - activeSprint.startDate.getTime()) / (24 * 60 * 60 * 1000)) || 7;
      rangeLabel = "sprint";
    } else {
      rangeDays = 14;
      rangeLabel = "14d";
    }
  }

  const rangeStart = sprintRangeStart || new Date(now.getTime() - rangeDays * 24 * 60 * 60 * 1000);

  // Build project filter
  const projectFilter = projectId ? { projectId } : {};

  // Fetch all data in parallel
  const [sessions, allAgents, projects, auditLogs, burnRate, sprintProjection, dailyCosts] = await Promise.all([
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
    prisma.auditLog.findMany({
      where: {
        action: "pr.merged",
        createdAt: { gte: rangeStart },
        ...(projectId ? { projectId } : {}),
      },
      select: { details: true },
    }),
    getCurrentBurnRate(projectId),
    projectToSprintEnd(projectId),
    getDailyCostSeries(projectId, rangeDays),
  ]);

  const hasData = sessions.length > 0;

  // --- DORA-like Metrics ---

  // Deployment Frequency: completed sessions per day over range
  const completedRecent = sessions.filter(
    (s) =>
      s.status === "completed" &&
      s.completedAt &&
      s.completedAt >= rangeStart,
  );
  const deploymentFrequency =
    completedRecent.length > 0
      ? (completedRecent.length / rangeDays).toFixed(1)
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

  // Auto-Merge Rate: PRs with autoMerge:true / total merged PRs
  const totalMerged = auditLogs.length;
  const autoMerged = auditLogs.filter((log) => {
    try {
      const d = JSON.parse(log.details);
      return d.autoMerge === true;
    } catch {
      return false;
    }
  }).length;
  const autoMergeRate =
    totalMerged > 0 ? `${Math.round((autoMerged / totalMerged) * 100)}%` : "—";

  // Tokens per Story Point: sum tokens / sum story points from completed sessions
  const totalTokens = sessions
    .filter((s) => s.status === "completed")
    .reduce((sum, s) => sum + s.tokensUsed, 0);
  const tokensPerSp = totalTokens > 0 && uniqueTickets.size > 0
    ? `${Math.round(totalTokens / uniqueTickets.size).toLocaleString()}`
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

  // --- Daily velocity data for chart ---
  const velocityByDay = new Map<string, { completed: number; failed: number }>();
  for (const s of sessions) {
    if (!s.completedAt || s.completedAt < rangeStart) continue;
    const dateStr = s.completedAt.toISOString().split("T")[0];
    const existing = velocityByDay.get(dateStr) || { completed: 0, failed: 0 };
    if (s.status === "completed") existing.completed++;
    else if (s.status === "failed") existing.failed++;
    velocityByDay.set(dateStr, existing);
  }

  // Fill in missing days for velocity
  const velocityData: { date: string; completed: number; failed: number }[] = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split("T")[0];
    const v = velocityByDay.get(dateStr) || { completed: 0, failed: 0 };
    velocityData.push({ date: dateStr, ...v });
  }
  const maxVelocity = Math.max(1, ...velocityData.map((d) => d.completed + d.failed));

  // Max for cost chart
  const maxDailyCost = Math.max(0.01, ...dailyCosts.map((d) => d.cost));

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
    { label: "Auto-Merge Rate", value: autoMergeRate },
    { label: "Avg Cost/Ticket", value: hasData ? avgCostPerTicket : "—" },
    { label: "Tokens/Ticket", value: tokensPerSp },
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
          <DateRangeSelector />
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

      {/* Cost Projections */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Cost Projections</h2>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div>
            <div className="text-xs text-gray-500">Daily Burn Rate</div>
            <div className="mt-1 text-lg font-semibold">
              ${burnRate.dailyRate.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Weekly Burn Rate</div>
            <div className="mt-1 text-lg font-semibold">
              ${burnRate.weeklyRate.toFixed(2)}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Sprint Projection</div>
            <div className="mt-1 text-lg font-semibold">
              {sprintProjection
                ? `$${sprintProjection.projectedCost.toFixed(2)}`
                : "No active sprint"}
            </div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Days Remaining</div>
            <div className="mt-1 text-lg font-semibold">
              {sprintProjection ? sprintProjection.daysRemaining : "—"}
            </div>
          </div>
        </div>
      </div>

      {/* Velocity Chart */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Velocity</h2>
        {hasData ? (
          <div className="h-48 flex items-end gap-px">
            {velocityData.map((d) => {
              const completedH = (d.completed / maxVelocity) * 100;
              const failedH = (d.failed / maxVelocity) * 100;
              return (
                <div
                  key={d.date}
                  className="flex-1 flex flex-col justify-end items-center group relative"
                >
                  <div
                    className="absolute -top-8 hidden group-hover:block text-xs bg-gray-800 px-2 py-1 rounded whitespace-nowrap z-10"
                  >
                    {d.date.slice(5)}: {d.completed} done, {d.failed} failed
                  </div>
                  {d.failed > 0 && (
                    <div
                      className="w-full bg-red-600 rounded-t-sm"
                      style={{ height: `${failedH}%`, minHeight: d.failed > 0 ? "2px" : 0 }}
                    />
                  )}
                  <div
                    className="w-full bg-blue-600 rounded-t-sm"
                    style={{ height: `${completedH}%`, minHeight: d.completed > 0 ? "2px" : 0 }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-48 items-center justify-center text-gray-500">
            No session data yet — velocity chart will appear once agents complete work
          </div>
        )}
        <div className="flex justify-between mt-2 text-xs text-gray-500">
          <span>{velocityData[0]?.date.slice(5)}</span>
          <span className="flex gap-4">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-blue-600 rounded-sm" /> Completed
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 bg-red-600 rounded-sm" /> Failed
            </span>
          </span>
          <span>{velocityData[velocityData.length - 1]?.date.slice(5)}</span>
        </div>
      </div>

      {/* Daily Cost Chart */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Daily Cost</h2>
        {dailyCosts.some((d) => d.cost > 0) ? (
          <div className="h-32 flex items-end gap-px">
            {dailyCosts.map((d) => {
              const h = (d.cost / maxDailyCost) * 100;
              return (
                <div
                  key={d.date}
                  className="flex-1 flex flex-col justify-end items-center group relative"
                >
                  <div
                    className="absolute -top-8 hidden group-hover:block text-xs bg-gray-800 px-2 py-1 rounded whitespace-nowrap z-10"
                  >
                    {d.date.slice(5)}: ${d.cost.toFixed(2)}
                  </div>
                  <div
                    className="w-full bg-emerald-600 rounded-t-sm"
                    style={{ height: `${h}%`, minHeight: d.cost > 0 ? "2px" : 0 }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-gray-500">
            No cost data yet
          </div>
        )}
        <div className="flex justify-between mt-2 text-xs text-gray-500">
          <span>{dailyCosts[0]?.date.slice(5)}</span>
          <span>{dailyCosts[dailyCosts.length - 1]?.date.slice(5)}</span>
        </div>
      </div>

      {/* Cost Breakdown by Model */}
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
