/**
 * Cost projection and analytics service.
 * Provides burn rate calculations, sprint projections, backlog cost estimates,
 * and synthetic savings tracking.
 */

import { prisma } from "./db";

// ── Burn Rate ─────────────────────────────────────────────────────────

export async function getCurrentBurnRate(projectId?: string): Promise<{
  dailyRate: number;
  weeklyRate: number;
  daysAnalyzed: number;
}> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const projectFilter = projectId ? { projectId } : {};

  const [sessionAgg, usageAgg] = await Promise.all([
    prisma.session.aggregate({
      _sum: { cost: true },
      where: { startedAt: { gte: sevenDaysAgo }, ...projectFilter },
    }),
    prisma.aiUsageLog.aggregate({
      _sum: { cost: true },
      where: {
        createdAt: { gte: sevenDaysAgo },
        category: { not: "agent_run" },
        ...(projectId ? { projectId } : {}),
      },
    }),
  ]);

  const totalCost = (sessionAgg._sum.cost ?? 0) + (usageAgg._sum.cost ?? 0);
  const dailyRate = totalCost / 7;

  return {
    dailyRate,
    weeklyRate: totalCost,
    daysAnalyzed: 7,
  };
}

// ── Sprint End Projection ─────────────────────────────────────────────

export async function projectToSprintEnd(projectId?: string): Promise<{
  projectedCost: number;
  daysRemaining: number;
  dailyRate: number;
} | null> {
  const { dailyRate } = await getCurrentBurnRate(projectId);

  // Find active sprint
  const sprint = projectId
    ? await prisma.sprint.findFirst({
        where: { project: { id: projectId }, state: "active" },
      })
    : await prisma.sprint.findFirst({ where: { state: "active" } });

  if (!sprint?.endDate) return null;

  const now = new Date();
  const daysRemaining = Math.max(
    0,
    (sprint.endDate.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)
  );

  return {
    projectedCost: dailyRate * daysRemaining,
    daysRemaining: Math.round(daysRemaining),
    dailyRate,
  };
}

// ── Backlog Cost Estimate ─────────────────────────────────────────────

export async function estimateBacklogCost(projectId?: string): Promise<{
  avgCostPerTicket: number;
  backlogCount: number;
  estimatedCost: number;
}> {
  const projectFilter = projectId ? { projectId } : {};

  // Get average cost per unique ticket from completed sessions
  const completedSessions = await prisma.session.findMany({
    where: { status: "completed", ...projectFilter },
    select: { ticketKey: true, cost: true },
  });

  const ticketCosts = new Map<string, number>();
  for (const s of completedSessions) {
    ticketCosts.set(s.ticketKey, (ticketCosts.get(s.ticketKey) ?? 0) + s.cost);
  }

  const totalCost = Array.from(ticketCosts.values()).reduce((a, b) => a + b, 0);
  const avgCostPerTicket =
    ticketCosts.size > 0 ? totalCost / ticketCosts.size : 0;

  // Count "To Do" sessions as proxy for backlog (or use a rough estimate)
  const backlogCount = await prisma.session.count({
    where: { status: "running", ...projectFilter },
  });

  return {
    avgCostPerTicket,
    backlogCount,
    estimatedCost: avgCostPerTicket * backlogCount,
  };
}

// ── Synthetic Savings ─────────────────────────────────────────────────

export async function getSyntheticSavings(
  projectId?: string,
  period?: "today" | "week" | "month" | "all"
): Promise<{
  localRuns: number;
  syntheticCost: number;
  actualCost: number;
  netSavings: number;
}> {
  let dateFilter: Date | undefined;
  const now = new Date();

  switch (period) {
    case "today":
      dateFilter = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case "week": {
      const dayOfWeek = now.getDay();
      const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      dateFilter = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - daysSinceMonday
      );
      break;
    }
    case "month":
      dateFilter = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    default:
      dateFilter = undefined;
  }

  const whereClause = {
    isLocal: true,
    ...(projectId ? { projectId } : {}),
    ...(dateFilter ? { createdAt: { gte: dateFilter } } : {}),
  };

  const [countResult, costAgg] = await Promise.all([
    prisma.aiUsageLog.count({ where: whereClause }),
    prisma.aiUsageLog.aggregate({
      _sum: { syntheticCost: true, cost: true },
      where: whereClause,
    }),
  ]);

  const syntheticCost = costAgg._sum.syntheticCost ?? 0;
  const actualCost = costAgg._sum.cost ?? 0;

  return {
    localRuns: countResult,
    syntheticCost,
    actualCost,
    netSavings: syntheticCost - actualCost,
  };
}

// ── Cost by Category ──────────────────────────────────────────────────

export async function getCostByCategory(projectId?: string): Promise<
  { category: string; cost: number; count: number }[]
> {
  const logs = await prisma.aiUsageLog.findMany({
    where: projectId ? { projectId } : undefined,
    select: { category: true, cost: true },
  });

  const categoryMap = new Map<string, { cost: number; count: number }>();
  for (const log of logs) {
    const existing = categoryMap.get(log.category) || { cost: 0, count: 0 };
    existing.cost += log.cost;
    existing.count += 1;
    categoryMap.set(log.category, existing);
  }

  return Array.from(categoryMap.entries())
    .map(([category, data]) => ({ category, ...data }))
    .sort((a, b) => b.cost - a.cost);
}

// ── Cost by Model ─────────────────────────────────────────────────────

export async function getCostByModel(projectId?: string): Promise<
  {
    model: string;
    cost: number;
    count: number;
    totalTokens: number;
    isLocal: boolean;
  }[]
> {
  const logs = await prisma.aiUsageLog.findMany({
    where: projectId ? { projectId } : undefined,
    select: {
      actualModel: true,
      cost: true,
      totalTokens: true,
      isLocal: true,
    },
  });

  const modelMap = new Map<
    string,
    { cost: number; count: number; totalTokens: number; isLocal: boolean }
  >();
  for (const log of logs) {
    const model = log.actualModel || "unknown";
    const existing = modelMap.get(model) || {
      cost: 0,
      count: 0,
      totalTokens: 0,
      isLocal: log.isLocal,
    };
    existing.cost += log.cost;
    existing.count += 1;
    existing.totalTokens += log.totalTokens;
    modelMap.set(model, existing);
  }

  return Array.from(modelMap.entries())
    .map(([model, data]) => ({ model, ...data }))
    .sort((a, b) => b.cost - a.cost);
}

// ── Cost by Project ───────────────────────────────────────────────────

export async function getCostByProject(): Promise<
  { projectId: string; projectName: string; cost: number; sessionCount: number }[]
> {
  const projects = await prisma.project.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
  });

  const results = await Promise.all(
    projects.map(async (project) => {
      const [sessionAgg, usageAgg, sessionCount] = await Promise.all([
        prisma.session.aggregate({
          _sum: { cost: true },
          where: { projectId: project.id },
        }),
        prisma.aiUsageLog.aggregate({
          _sum: { cost: true },
          where: { projectId: project.id, category: { not: "agent_run" } },
        }),
        prisma.session.count({ where: { projectId: project.id } }),
      ]);

      return {
        projectId: project.id,
        projectName: project.name,
        cost:
          (sessionAgg._sum.cost ?? 0) + (usageAgg._sum.cost ?? 0),
        sessionCount,
      };
    })
  );

  return results.sort((a, b) => b.cost - a.cost);
}

// ── Daily Cost Time Series ────────────────────────────────────────────

export async function getDailyCostSeries(
  projectId?: string,
  days: number = 30
): Promise<{ date: string; cost: number }[]> {
  const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const projectFilter = projectId ? { projectId } : {};

  const sessions = await prisma.session.findMany({
    where: { startedAt: { gte: startDate }, ...projectFilter },
    select: { startedAt: true, cost: true },
  });

  const dailyMap = new Map<string, number>();
  for (const s of sessions) {
    const dateStr = s.startedAt.toISOString().split("T")[0];
    dailyMap.set(dateStr, (dailyMap.get(dateStr) ?? 0) + s.cost);
  }

  // Fill in missing days
  const result: { date: string; cost: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split("T")[0];
    result.push({ date: dateStr, cost: dailyMap.get(dateStr) ?? 0 });
  }

  return result;
}
