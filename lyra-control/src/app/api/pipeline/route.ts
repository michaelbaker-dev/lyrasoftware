import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

interface TimelineEvent {
  id: string;
  type: "session" | "gate" | "audit" | "triage" | "memory";
  timestamp: string;
  title: string;
  details: string;
  status?: "success" | "failure" | "info" | "warning";
}

interface TicketPipeline {
  ticketKey: string;
  summary: string;
  status: "active" | "queued" | "abandoned" | "completed";
  attemptCount: number;
  totalCost: number;
  events: TimelineEvent[];
}

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const projectId = url.searchParams.get("projectId") || undefined;
    const statusFilter = url.searchParams.get("status") || undefined;

    const projectFilter = projectId ? { projectId } : {};

    // Fetch all data sources in parallel
    const [sessions, gateRuns, auditLogs, triageLogs, memories] = await Promise.all([
      prisma.session.findMany({
        where: projectFilter,
        include: { agent: { select: { name: true } } },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      prisma.qualityGateRun.findMany({
        where: projectFilter,
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.auditLog.findMany({
        where: {
          ...projectFilter,
          action: {
            in: [
              "agent.started",
              "agent.completed",
              "agent.failed",
              "agent.phantom_completion",
              "agent.force_escalation",
            ],
          },
        },
        orderBy: { createdAt: "desc" },
        take: 500,
      }),
      prisma.triageLog.findMany({
        where: projectFilter,
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
      prisma.lyraMemory.findMany({
        where: {
          ...projectFilter,
          category: { in: ["decision", "escalation"] },
        },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    ]);

    // Build per-ticket timelines
    const ticketMap = new Map<string, TicketPipeline>();

    function ensureTicket(ticketKey: string): TicketPipeline {
      if (!ticketMap.has(ticketKey)) {
        ticketMap.set(ticketKey, {
          ticketKey,
          summary: "",
          status: "queued",
          attemptCount: 0,
          totalCost: 0,
          events: [],
        });
      }
      return ticketMap.get(ticketKey)!;
    }

    // Sessions
    for (const s of sessions) {
      const t = ensureTicket(s.ticketKey);
      if (!t.summary) t.summary = s.branch;
      t.totalCost += s.cost;

      const statusMap: Record<string, "success" | "failure" | "info" | "warning"> = {
        completed: "success",
        failed: "failure",
        running: "info",
        cancelled: "warning",
      };

      t.events.push({
        id: `session-${s.id}`,
        type: "session",
        timestamp: s.createdAt.toISOString(),
        title: `Session ${s.status} (${s.agent?.name || "unknown"})`,
        details: s.status === "failed"
          ? (s.output || "").slice(-300)
          : `Cost: $${s.cost.toFixed(4)}, Tokens: ${s.tokensUsed}`,
        status: statusMap[s.status] || "info",
      });

      if (s.status === "running") t.status = "active";
      if (s.status === "failed" || s.status === "cancelled") {
        t.attemptCount++;
      }
    }

    // Quality gate runs
    for (const g of gateRuns) {
      const t = ensureTicket(g.ticketKey);
      t.events.push({
        id: `gate-${g.id}`,
        type: "gate",
        timestamp: g.createdAt.toISOString(),
        title: `Quality Gate ${g.passed ? "PASSED" : "FAILED"}`,
        details: g.reasoning.slice(0, 300),
        status: g.passed ? "success" : "failure",
      });
    }

    // Audit logs
    for (const a of auditLogs) {
      let ticketKey: string | undefined;
      try {
        const d = JSON.parse(a.details);
        ticketKey = d.ticketKey;
      } catch { /* skip */ }
      if (!ticketKey) continue;

      const t = ensureTicket(ticketKey);
      const statusMap: Record<string, "success" | "failure" | "info" | "warning"> = {
        "agent.started": "info",
        "agent.completed": "success",
        "agent.failed": "failure",
        "agent.phantom_completion": "warning",
        "agent.force_escalation": "warning",
      };
      t.events.push({
        id: `audit-${a.id}`,
        type: "audit",
        timestamp: a.createdAt.toISOString(),
        title: a.action.replace(/\./g, " ").replace(/^./, (c) => c.toUpperCase()),
        details: a.details.slice(0, 300),
        status: statusMap[a.action] || "info",
      });
    }

    // Triage logs
    for (const tl of triageLogs) {
      const t = ensureTicket(tl.ticketKey);
      if (tl.ticketSummary && !t.summary) t.summary = tl.ticketSummary;
      t.events.push({
        id: `triage-${tl.id}`,
        type: "triage",
        timestamp: tl.createdAt.toISOString(),
        title: `Triage: ${tl.action} (${tl.category})`,
        details: `${tl.summary} — Fix: ${tl.suggestedFix}`.slice(0, 300),
        status: tl.action === "escalate" ? "failure" : "warning",
      });
    }

    // Lyra memories (filter by ticket key in content)
    for (const m of memories) {
      try {
        const content = JSON.parse(m.content);
        const ticketKey = content.ticketKey || content.event?.ticketKey;
        if (!ticketKey) continue;
        const t = ensureTicket(ticketKey);
        t.events.push({
          id: `memory-${m.id}`,
          type: "memory",
          timestamp: m.createdAt.toISOString(),
          title: `Lyra ${m.category}`,
          details: (content.reasoning || content.decision || JSON.stringify(content)).slice(0, 300),
          status: "info",
        });
      } catch { /* skip non-JSON */ }
    }

    // Determine final status for each ticket
    const maxRetries = 5;
    for (const t of ticketMap.values()) {
      // Sort events by timestamp descending
      t.events.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

      if (t.status === "active") continue; // already set

      const hasPassedGate = t.events.some(
        (e) => e.type === "gate" && e.status === "success"
      );
      if (hasPassedGate) {
        t.status = "completed";
        continue;
      }

      if (t.attemptCount >= maxRetries) {
        t.status = "abandoned";
        continue;
      }

      t.status = "queued";
    }

    // Convert to array and apply status filter
    let tickets = Array.from(ticketMap.values());
    if (statusFilter) {
      tickets = tickets.filter((t) => t.status === statusFilter);
    }

    // Sort: active first, then abandoned, queued, completed
    const statusOrder: Record<string, number> = { active: 0, abandoned: 1, queued: 2, completed: 3 };
    tickets.sort((a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99));

    // Summary counts
    const allTickets = Array.from(ticketMap.values());
    const summary = {
      active: allTickets.filter((t) => t.status === "active").length,
      queued: allTickets.filter((t) => t.status === "queued").length,
      abandoned: allTickets.filter((t) => t.status === "abandoned").length,
      completed: allTickets.filter((t) => t.status === "completed").length,
    };

    return NextResponse.json({ tickets, summary });
  } catch (e) {
    console.error("[API/pipeline] GET error:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
