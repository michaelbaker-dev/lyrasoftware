import { prisma } from "@/lib/db";
import ProjectSelector from "@/components/project-selector";
import {
  getCurrentBurnRate,
  projectToSprintEnd,
  getSyntheticSavings,
  getCostByCategory,
  getCostByModel,
  getCostByProject,
  getDailyCostSeries,
} from "@/lib/cost-projections";

export const dynamic = "force-dynamic";

export default async function CostsPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: projectId } = await searchParams;

  const projects = await prisma.project.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
  });

  // ── Aggregate data ──────────────────────────────────────────────────

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayOfWeek = now.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const projectFilter = projectId ? { projectId } : {};
  const usageProjectFilter = projectId ? { projectId } : {};

  // Cost totals — sessions + non-agent_run usage logs
  const [
    todaySessionAgg,
    weekSessionAgg,
    monthSessionAgg,
    allTimeSessionAgg,
    todayUsageAgg,
    weekUsageAgg,
    monthUsageAgg,
    allTimeUsageAgg,
  ] = await Promise.all([
    prisma.session.aggregate({ _sum: { cost: true }, where: { startedAt: { gte: startOfToday }, ...projectFilter } }),
    prisma.session.aggregate({ _sum: { cost: true }, where: { startedAt: { gte: startOfWeek }, ...projectFilter } }),
    prisma.session.aggregate({ _sum: { cost: true }, where: { startedAt: { gte: startOfMonth }, ...projectFilter } }),
    prisma.session.aggregate({ _sum: { cost: true }, where: projectFilter }),
    prisma.aiUsageLog.aggregate({ _sum: { cost: true }, where: { createdAt: { gte: startOfToday }, category: { not: "agent_run" }, ...usageProjectFilter } }),
    prisma.aiUsageLog.aggregate({ _sum: { cost: true }, where: { createdAt: { gte: startOfWeek }, category: { not: "agent_run" }, ...usageProjectFilter } }),
    prisma.aiUsageLog.aggregate({ _sum: { cost: true }, where: { createdAt: { gte: startOfMonth }, category: { not: "agent_run" }, ...usageProjectFilter } }),
    prisma.aiUsageLog.aggregate({ _sum: { cost: true }, where: { category: { not: "agent_run" }, ...usageProjectFilter } }),
  ]);

  const costs = {
    today: (todaySessionAgg._sum.cost ?? 0) + (todayUsageAgg._sum.cost ?? 0),
    week: (weekSessionAgg._sum.cost ?? 0) + (weekUsageAgg._sum.cost ?? 0),
    month: (monthSessionAgg._sum.cost ?? 0) + (monthUsageAgg._sum.cost ?? 0),
    allTime: (allTimeSessionAgg._sum.cost ?? 0) + (allTimeUsageAgg._sum.cost ?? 0),
  };

  // ── Analytics data ──────────────────────────────────────────────────

  const [
    burnRate,
    sprintProjection,
    savings,
    costByCategory,
    costByModel,
    costByProject,
    dailySeries,
  ] = await Promise.all([
    getCurrentBurnRate(projectId),
    projectToSprintEnd(projectId),
    getSyntheticSavings(projectId, "month"),
    getCostByCategory(projectId),
    getCostByModel(projectId),
    getCostByProject(),
    getDailyCostSeries(projectId, 30),
  ]);

  // Cost per story point
  const completedSprints = await prisma.sprint.findMany({
    where: {
      completedPoints: { gt: 0 },
      ...(projectId ? { projectId } : {}),
    },
    select: { completedPoints: true },
  });
  const totalPoints = completedSprints.reduce((sum, s) => sum + s.completedPoints, 0);
  const costPerPoint = totalPoints > 0 ? costs.allTime / totalPoints : 0;

  // Projected monthly cost
  const projectedMonthlyCost = burnRate.dailyRate * 30;

  // Max values for bar charts
  const maxCategoryCost = Math.max(...costByCategory.map((c) => c.cost), 1);
  const maxModelCost = Math.max(...costByModel.map((m) => m.cost), 1);
  const maxProjectCost = Math.max(...costByProject.map((p) => p.cost), 1);
  const maxDailyCost = Math.max(...dailySeries.map((d) => d.cost), 1);

  const selectedProject = projectId ? projects.find((p) => p.id === projectId) : null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Cost Analytics</h1>
          {selectedProject && (
            <p className="text-sm text-gray-400 mt-1">
              Filtered to: {selectedProject.name}
            </p>
          )}
        </div>
        <ProjectSelector projects={projects} />
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-5">
        <SummaryCard label="Today" value={`$${costs.today.toFixed(2)}`} />
        <SummaryCard label="This Week" value={`$${costs.week.toFixed(2)}`} />
        <SummaryCard label="This Month" value={`$${costs.month.toFixed(2)}`} />
        <SummaryCard label="All Time" value={`$${costs.allTime.toFixed(2)}`} />
        <SummaryCard
          label="Cost / Story Point"
          value={costPerPoint > 0 ? `$${costPerPoint.toFixed(2)}` : "---"}
        />
      </div>

      {/* Projections Row */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="text-sm text-gray-400">Daily Burn Rate</div>
          <div className="mt-1 text-2xl font-bold">${burnRate.dailyRate.toFixed(2)}/day</div>
          <div className="mt-1 text-xs text-gray-500">
            Based on last {burnRate.daysAnalyzed} days
          </div>
        </div>
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <div className="text-sm text-gray-400">Projected Monthly</div>
          <div className="mt-1 text-2xl font-bold">${projectedMonthlyCost.toFixed(2)}</div>
          <div className="mt-1 text-xs text-gray-500">
            At current burn rate
          </div>
        </div>
        {sprintProjection ? (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-sm text-gray-400">Sprint End Projection</div>
            <div className="mt-1 text-2xl font-bold">
              ${sprintProjection.projectedCost.toFixed(2)}
            </div>
            <div className="mt-1 text-xs text-gray-500">
              {sprintProjection.daysRemaining} days remaining
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
            <div className="text-sm text-gray-400">Sprint End Projection</div>
            <div className="mt-1 text-2xl font-bold text-gray-600">---</div>
            <div className="mt-1 text-xs text-gray-500">No active sprint</div>
          </div>
        )}
      </div>

      {/* Synthetic Savings */}
      {savings.localRuns > 0 && (
        <div className="rounded-xl border border-green-900/50 bg-green-950/30 p-5">
          <h2 className="text-lg font-semibold text-green-400 mb-3">
            Local Model Savings
          </h2>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div>
              <div className="text-xs text-gray-400">Local Runs</div>
              <div className="mt-1 text-lg font-semibold">{savings.localRuns}</div>
            </div>
            <div>
              <div className="text-xs text-gray-400">Cloud Equivalent Cost</div>
              <div className="mt-1 text-lg font-semibold">
                ${savings.syntheticCost.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-400">Actual Cost</div>
              <div className="mt-1 text-lg font-semibold">
                ${savings.actualCost.toFixed(2)}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-400">Net Savings</div>
              <div className="mt-1 text-lg font-semibold text-green-400">
                +${savings.netSavings.toFixed(2)}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Cost Trend (30-day bar chart) */}
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="mb-4 text-lg font-semibold">Daily Cost Trend (30 days)</h2>
        {dailySeries.some((d) => d.cost > 0) ? (
          <div className="flex items-end gap-px h-32">
            {dailySeries.map((day) => (
              <div
                key={day.date}
                className="flex-1 group relative"
                title={`${day.date}: $${day.cost.toFixed(2)}`}
              >
                <div
                  className="bg-blue-600 rounded-t-sm w-full transition-all hover:bg-blue-500"
                  style={{
                    height: `${maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0}%`,
                    minHeight: day.cost > 0 ? "2px" : "0",
                  }}
                />
              </div>
            ))}
          </div>
        ) : (
          <div className="flex h-32 items-center justify-center text-gray-500">
            No cost data yet
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* Cost by Category */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="mb-4 text-lg font-semibold">Cost by Category</h2>
          {costByCategory.length > 0 ? (
            <div className="space-y-3">
              {costByCategory.map((row) => (
                <div key={row.category} className="flex items-center gap-4">
                  <div className="w-28 text-sm text-gray-300 truncate">
                    {row.category}
                  </div>
                  <div className="flex-1">
                    <div className="h-2 rounded-full bg-gray-800">
                      <div
                        className="h-2 rounded-full bg-purple-600"
                        style={{
                          width: `${(row.cost / maxCategoryCost) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                  <div className="w-24 text-right text-sm text-gray-400">
                    ${row.cost.toFixed(2)}
                    <span className="text-xs text-gray-600 ml-1">
                      ({row.count})
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-20 items-center justify-center text-gray-500">
              No usage data yet
            </div>
          )}
        </div>

        {/* Cost by Model */}
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="mb-4 text-lg font-semibold">Cost by Model</h2>
          {costByModel.length > 0 ? (
            <div className="space-y-3">
              {costByModel.map((row) => (
                <div key={row.model} className="flex items-center gap-4">
                  <div className="w-40 text-sm text-gray-300 truncate flex items-center gap-1">
                    {row.model}
                    {row.isLocal && (
                      <span className="text-xs text-green-500 font-medium">
                        local
                      </span>
                    )}
                  </div>
                  <div className="flex-1">
                    <div className="h-2 rounded-full bg-gray-800">
                      <div
                        className={`h-2 rounded-full ${row.isLocal ? "bg-green-600" : "bg-blue-600"}`}
                        style={{
                          width: `${(row.cost / maxModelCost) * 100}%`,
                          minWidth: row.cost > 0 ? "2px" : "0",
                        }}
                      />
                    </div>
                  </div>
                  <div className="w-24 text-right text-sm text-gray-400">
                    {row.isLocal ? "$0.00" : `$${row.cost.toFixed(2)}`}
                    <span className="text-xs text-gray-600 ml-1">
                      ({row.count})
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex h-20 items-center justify-center text-gray-500">
              No model data yet
            </div>
          )}
        </div>
      </div>

      {/* Cost by Project (only shown in program view) */}
      {!projectId && costByProject.length > 0 && (
        <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
          <h2 className="mb-4 text-lg font-semibold">Cost by Project</h2>
          <div className="space-y-3">
            {costByProject.map((row) => (
              <div key={row.projectId} className="flex items-center gap-4">
                <div className="w-40 text-sm text-gray-300 truncate">
                  {row.projectName}
                </div>
                <div className="flex-1">
                  <div className="h-2 rounded-full bg-gray-800">
                    <div
                      className="h-2 rounded-full bg-cyan-600"
                      style={{
                        width: `${(row.cost / maxProjectCost) * 100}%`,
                        minWidth: row.cost > 0 ? "2px" : "0",
                      }}
                    />
                  </div>
                </div>
                <div className="w-28 text-right text-sm text-gray-400">
                  ${row.cost.toFixed(2)}
                  <span className="text-xs text-gray-600 ml-1">
                    ({row.sessionCount} sessions)
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Ticket-Level Costs */}
      <TicketCosts projectId={projectId} />
    </div>
  );
}

// ── Helper Components ─────────────────────────────────────────────────

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <div className="text-sm text-gray-400">{label}</div>
      <div className="mt-1 text-2xl font-bold">{value}</div>
    </div>
  );
}

async function TicketCosts({ projectId }: { projectId?: string }) {
  const projectFilter = projectId ? { projectId } : {};

  // Get top 20 most expensive tickets
  const sessions = await prisma.session.findMany({
    where: projectFilter,
    select: {
      ticketKey: true,
      cost: true,
      status: true,
      project: { select: { name: true } },
    },
  });

  const ticketMap = new Map<
    string,
    { cost: number; sessions: number; failed: number; projectName: string }
  >();

  for (const s of sessions) {
    const existing = ticketMap.get(s.ticketKey) || {
      cost: 0,
      sessions: 0,
      failed: 0,
      projectName: s.project.name,
    };
    existing.cost += s.cost;
    existing.sessions += 1;
    if (s.status === "failed") existing.failed += 1;
    ticketMap.set(s.ticketKey, existing);
  }

  const topTickets = Array.from(ticketMap.entries())
    .map(([key, data]) => ({ ticketKey: key, ...data }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);

  if (topTickets.length === 0) return null;

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="mb-4 text-lg font-semibold">Top Tickets by Cost</h2>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500 border-b border-gray-800">
              <th className="pb-2 pr-4">Ticket</th>
              {!projectId && <th className="pb-2 pr-4">Project</th>}
              <th className="pb-2 pr-4 text-right">Cost</th>
              <th className="pb-2 pr-4 text-right">Sessions</th>
              <th className="pb-2 text-right">Failed</th>
            </tr>
          </thead>
          <tbody>
            {topTickets.map((ticket) => (
              <tr
                key={ticket.ticketKey}
                className="border-b border-gray-800/50"
              >
                <td className="py-2 pr-4 font-mono text-blue-400">
                  {ticket.ticketKey}
                </td>
                {!projectId && (
                  <td className="py-2 pr-4 text-gray-400">
                    {ticket.projectName}
                  </td>
                )}
                <td className="py-2 pr-4 text-right">
                  ${ticket.cost.toFixed(2)}
                </td>
                <td className="py-2 pr-4 text-right text-gray-400">
                  {ticket.sessions}
                </td>
                <td className="py-2 text-right">
                  {ticket.failed > 0 ? (
                    <span className="text-red-400">{ticket.failed}</span>
                  ) : (
                    <span className="text-gray-600">0</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
