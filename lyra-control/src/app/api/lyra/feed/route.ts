import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

interface FeedItem {
  id: string;
  type: "decision" | "observation" | "escalation" | "reflection" | "gate" | "triage";
  timestamp: string;
  title: string;
  details: string;
  status: "success" | "failure" | "warning" | "info";
  ticketKey?: string;
  confidence?: number;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get("projectId");
  const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 200);

  const memoryWhere = projectId ? { projectId } : {};
  const projectWhere = projectId ? { projectId } : {};

  // Query in parallel
  const [memories, gates, triageLogs] = await Promise.all([
    prisma.lyraMemory.findMany({
      where: memoryWhere,
      orderBy: { createdAt: "desc" },
      take: Math.min(limit, 100),
    }),
    prisma.qualityGateRun.findMany({
      where: projectWhere,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.triageLog.findMany({
      where: projectWhere,
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);

  // Map to unified feed items
  const items: FeedItem[] = [];

  for (const m of memories) {
    let parsed: { event?: string; decision?: string; reasoning?: string; action?: string; ticketKey?: string } = {};
    try {
      parsed = JSON.parse(m.content);
    } catch {
      parsed = { event: m.content.slice(0, 200) };
    }

    const confidence = parsed.reasoning ? undefined : undefined;

    switch (m.category) {
      case "decision":
        items.push({
          id: m.id,
          type: "decision",
          timestamp: m.createdAt.toISOString(),
          title: `Decision: ${parsed.action || parsed.decision || "unknown"}`,
          details: parsed.reasoning || parsed.event || m.content.slice(0, 200),
          status: "info",
          ticketKey: parsed.ticketKey,
          confidence,
        });
        break;
      case "observation":
        items.push({
          id: m.id,
          type: "observation",
          timestamp: m.createdAt.toISOString(),
          title: `Observation: ${parsed.event || "noted"}`,
          details: parsed.reasoning || m.content.slice(0, 200),
          status: "info",
        });
        break;
      case "escalation":
        items.push({
          id: m.id,
          type: "escalation",
          timestamp: m.createdAt.toISOString(),
          title: `Escalation: ${parsed.ticketKey || "issue"}`,
          details: parsed.reasoning || parsed.event || m.content.slice(0, 200),
          status: "warning",
          ticketKey: parsed.ticketKey,
        });
        break;
      case "reflection":
        items.push({
          id: m.id,
          type: "reflection",
          timestamp: m.createdAt.toISOString(),
          title: "Reflection",
          details: parsed.reasoning || parsed.event || m.content.slice(0, 200),
          status: "info",
        });
        break;
    }
  }

  for (const g of gates) {
    items.push({
      id: g.id,
      type: "gate",
      timestamp: g.createdAt.toISOString(),
      title: `Gate: ${g.ticketKey} ${g.passed ? "PASSED" : "FAILED"}`,
      details: g.reasoning.slice(0, 200),
      status: g.passed ? "success" : "failure",
      ticketKey: g.ticketKey,
    });
  }

  for (const t of triageLogs) {
    items.push({
      id: t.id,
      type: "triage",
      timestamp: t.createdAt.toISOString(),
      title: `Triage: ${t.ticketKey} → ${t.action}`,
      details: t.summary.slice(0, 200),
      status: t.resolution === "fixed" ? "success" : t.resolution === "open" ? "warning" : "failure",
      ticketKey: t.ticketKey,
      confidence: t.confidence,
    });
  }

  // Sort by timestamp descending
  items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  // Trim to limit
  const trimmed = items.slice(0, limit);

  // Compute summary
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const decisions24h = memories.filter(
    (m) => m.category === "decision" && m.createdAt >= twentyFourHoursAgo
  ).length;
  const openEscalations = memories.filter((m) => m.category === "escalation").length;
  const gatesPassed = gates.filter((g) => g.passed).length;
  const gatesFailed = gates.filter((g) => !g.passed).length;
  const openTriage = triageLogs.filter((t) => t.resolution === "open").length;

  return NextResponse.json({
    items: trimmed,
    summary: {
      decisions24h,
      openEscalations,
      gatesPassed,
      gatesFailed,
      openTriage,
    },
  });
}
