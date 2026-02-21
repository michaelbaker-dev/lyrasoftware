const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();

async function main() {
  // Cost by category from AiUsageLog
  const logs = await p.aiUsageLog.findMany({
    select: { category: true, cost: true, provider: true, actualModel: true, isLocal: true },
  });
  const catMap = {};
  for (const l of logs) {
    const key = l.category;
    if (!catMap[key]) catMap[key] = { cost: 0, count: 0, providers: new Set() };
    catMap[key].cost += l.cost;
    catMap[key].count += 1;
    catMap[key].providers.add(l.provider);
  }
  console.log("=== AiUsageLog by Category ===");
  for (const [cat, d] of Object.entries(catMap)) {
    console.log("  " + cat + ": $" + d.cost.toFixed(4) + " (" + d.count + " calls) providers: " + [...d.providers].join(","));
  }

  // Session costs
  const sessionAgg = await p.session.aggregate({ _sum: { cost: true }, _count: { id: true } });
  console.log("\n=== Session costs ===");
  console.log("  Total: $" + (sessionAgg._sum.cost || 0).toFixed(4) + " across " + sessionAgg._count.id + " sessions");

  // Provider breakdown
  const providerMap = {};
  for (const l of logs) {
    const key = l.provider + " / " + l.actualModel;
    if (!providerMap[key]) providerMap[key] = { cost: 0, count: 0 };
    providerMap[key].cost += l.cost;
    providerMap[key].count += 1;
  }
  console.log("\n=== AiUsageLog by Provider/Model ===");
  for (const [k, d] of Object.entries(providerMap).sort((a,b) => b[1].cost - a[1].cost)) {
    console.log("  " + k + ": $" + d.cost.toFixed(4) + " (" + d.count + " calls)");
  }

  // What the dashboard would show
  const agentRunCost = logs.filter(l => l.category === "agent_run").reduce((s, l) => s + l.cost, 0);
  const nonAgentCost = logs.filter(l => l.category !== "agent_run").reduce((s, l) => s + l.cost, 0);
  console.log("\n=== Dashboard Display ===");
  console.log("  Session.cost total: $" + (sessionAgg._sum.cost || 0).toFixed(4));
  console.log("  AiUsageLog agent_run total: $" + agentRunCost.toFixed(4) + " (excluded from dashboard to avoid double-count)");
  console.log("  AiUsageLog non-agent_run total: $" + nonAgentCost.toFixed(4) + " (this IS shown on dashboard)");
  console.log("  Dashboard total: $" + ((sessionAgg._sum.cost || 0) + nonAgentCost).toFixed(4));

  // Check for double-counting: are agent_run costs duplicated in session.cost?
  const agentRunLogs = await p.aiUsageLog.findMany({
    where: { category: "agent_run" },
    select: { sessionId: true, cost: true },
  });
  console.log("\n=== Double-Count Check ===");
  let matches = 0;
  for (const arl of agentRunLogs) {
    if (arl.sessionId) {
      const session = await p.session.findUnique({ where: { id: arl.sessionId }, select: { cost: true } });
      if (session && Math.abs(session.cost - arl.cost) < 0.01) matches++;
    }
  }
  console.log("  agent_run logs matching session costs: " + matches + "/" + agentRunLogs.length);

  await p.$disconnect();
}

main();
