import { prisma } from "@/lib/db";
import CostTickerLive from "./cost-ticker-live";

const MODEL_COLORS: Record<string, string> = {
  "claude-opus": "bg-blue-500",
  "claude-sonnet": "bg-green-500",
  "claude-haiku": "bg-purple-500",
  "claude-max": "bg-indigo-500",
  "claude code": "bg-indigo-500",
  "deepseek": "bg-emerald-500",
  "openrouter": "bg-yellow-500",
};

function getModelColor(model: string): string {
  const lower = model.toLowerCase();
  for (const [key, color] of Object.entries(MODEL_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return "bg-gray-500";
}

export default async function CostTicker({ projectId }: { projectId?: string }) {
  const now = new Date();

  // Start of today (midnight local)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // Start of this week (Monday)
  const dayOfWeek = now.getDay();
  const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const startOfWeek = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysSinceMonday);

  // Start of this month
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Build project filter
  const projectFilter = projectId ? { projectId } : {};

  // Aggregate costs for each period — separate API costs (real money) from subscription costs (informational)
  // Sessions store total cost; AiUsageLog has per-call detail with provider info
  const [
    todaySessionAgg, weekSessionAgg, monthSessionAgg,
    todayUsageAgg, weekUsageAgg, monthUsageAgg,
    // API-only costs (OpenRouter, Tavily — real charges)
    todayApiAgg, weekApiAgg, monthApiAgg,
  ] = await Promise.all([
    prisma.session.aggregate({
      _sum: { cost: true },
      where: { startedAt: { gte: startOfToday }, ...projectFilter },
    }),
    prisma.session.aggregate({
      _sum: { cost: true },
      where: { startedAt: { gte: startOfWeek }, ...projectFilter },
    }),
    prisma.session.aggregate({
      _sum: { cost: true },
      where: { startedAt: { gte: startOfMonth }, ...projectFilter },
    }),
    prisma.aiUsageLog.aggregate({
      _sum: { cost: true },
      where: {
        createdAt: { gte: startOfToday },
        category: { not: "agent_run" }, // avoid double-counting with Session
        ...(projectId ? { projectId } : {}),
      },
    }),
    prisma.aiUsageLog.aggregate({
      _sum: { cost: true },
      where: {
        createdAt: { gte: startOfWeek },
        category: { not: "agent_run" },
        ...(projectId ? { projectId } : {}),
      },
    }),
    prisma.aiUsageLog.aggregate({
      _sum: { cost: true },
      where: {
        createdAt: { gte: startOfMonth },
        category: { not: "agent_run" },
        ...(projectId ? { projectId } : {}),
      },
    }),
    // API costs: OpenRouter provider (agent_run category = real API charges for non-Claude)
    // plus non-agent_run usage (Tavily, classification, etc.)
    prisma.aiUsageLog.aggregate({
      _sum: { cost: true },
      where: {
        createdAt: { gte: startOfToday },
        provider: { not: "claude-max" },
        category: { notIn: ["agent_run_turn"] }, // turns are sub-totals, agent_run has the total
        ...(projectId ? { projectId } : {}),
      },
    }),
    prisma.aiUsageLog.aggregate({
      _sum: { cost: true },
      where: {
        createdAt: { gte: startOfWeek },
        provider: { not: "claude-max" },
        category: { notIn: ["agent_run_turn"] },
        ...(projectId ? { projectId } : {}),
      },
    }),
    prisma.aiUsageLog.aggregate({
      _sum: { cost: true },
      where: {
        createdAt: { gte: startOfMonth },
        provider: { not: "claude-max" },
        category: { notIn: ["agent_run_turn"] },
        ...(projectId ? { projectId } : {}),
      },
    }),
  ]);

  const costs = {
    today: (todaySessionAgg._sum.cost ?? 0) + (todayUsageAgg._sum.cost ?? 0),
    week: (weekSessionAgg._sum.cost ?? 0) + (weekUsageAgg._sum.cost ?? 0),
    month: (monthSessionAgg._sum.cost ?? 0) + (monthUsageAgg._sum.cost ?? 0),
  };

  const apiCosts = {
    today: todayApiAgg._sum.cost ?? 0,
    week: weekApiAgg._sum.cost ?? 0,
    month: monthApiAgg._sum.cost ?? 0,
  };

  const subscriptionCosts = {
    today: costs.today - apiCosts.today,
    week: costs.week - apiCosts.week,
    month: costs.month - apiCosts.month,
  };

  // Breakdown by model — combine Session and AiUsageLog data
  const [sessions, usageLogs] = await Promise.all([
    prisma.session.findMany({
      where: { startedAt: { gte: startOfMonth }, ...projectFilter },
      select: { cost: true, agent: { select: { model: true } } },
    }),
    prisma.aiUsageLog.findMany({
      where: {
        createdAt: { gte: startOfMonth },
        category: { not: "agent_run" },
        ...(projectId ? { projectId } : {}),
      },
      select: { cost: true, actualModel: true },
    }),
  ]);

  const modelMap = new Map<string, number>();
  for (const s of sessions) {
    const model = s.agent?.model ?? "unknown";
    modelMap.set(model, (modelMap.get(model) ?? 0) + s.cost);
  }
  for (const u of usageLogs) {
    const model = u.actualModel || "unknown";
    modelMap.set(model, (modelMap.get(model) ?? 0) + u.cost);
  }

  const totalMonthCost = costs.month || 1; // avoid division by zero
  const modelBreakdown = Array.from(modelMap.entries())
    .map(([name, cost]) => ({
      name,
      cost,
      percentage: Math.round((cost / totalMonthCost) * 1000) / 10,
      color: getModelColor(name),
    }))
    .sort((a, b) => b.cost - a.cost);

  return (
    <CostTickerLive
      initialCosts={costs}
      apiCosts={apiCosts}
      subscriptionCosts={subscriptionCosts}
      modelBreakdown={modelBreakdown}
      projectId={projectId}
    />
  );
}
