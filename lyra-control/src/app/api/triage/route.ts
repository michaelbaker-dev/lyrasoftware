import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { addComment } from "@/lib/jira";
import { transitionToStatus, triggerDispatch, getState as getDispatcherState } from "@/lib/dispatcher";
import { startScheduler } from "@/lib/scheduler";

const VALID_RESOLUTIONS = ["open", "retrying", "fixed", "wontfix", "escalated"];
const TERMINAL_RESOLUTIONS = ["fixed", "wontfix"];

const MODEL_OPTIONS = [
  "claude-opus-4",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "openrouter/auto",
];

// GET — list triage entries with optional filters + summary
export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const projectId = url.searchParams.get("projectId") || undefined;
    const category = url.searchParams.get("category") || undefined;
    const resolution = url.searchParams.get("resolution") || undefined;
    const source = url.searchParams.get("source") || undefined;
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "100"), 500);
    const offset = parseInt(url.searchParams.get("offset") || "0");

    const where = {
      ...(projectId && { projectId }),
      ...(category && { category }),
      ...(resolution && { resolution }),
      ...(source && { source }),
    };

    const [entries, total, projects] = await Promise.all([
      prisma.triageLog.findMany({
        where,
        include: {
          project: { select: { name: true, jiraKey: true } },
          session: { select: { output: true, status: true } },
        },
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.triageLog.count({ where }),
      prisma.project.findMany({
        where: { status: "active" },
        select: { id: true, name: true, jiraKey: true },
        orderBy: { name: "asc" },
      }),
    ]);

    // Build summary — scoped to same filters as the entry list
    const allEntries = await prisma.triageLog.groupBy({
      by: ["resolution"],
      where,
      _count: true,
    });

    const byCategoryRaw = await prisma.triageLog.groupBy({
      by: ["category"],
      where,
      _count: true,
      orderBy: { _count: { category: "desc" } },
    });

    const byActionRaw = await prisma.triageLog.groupBy({
      by: ["action"],
      where,
      _count: true,
      orderBy: { _count: { action: "desc" } },
    });

    const summaryTotal = allEntries.reduce((sum, e) => sum + e._count, 0);
    const fixed = allEntries.find((e) => e.resolution === "fixed")?._count || 0;

    const summary = {
      total: summaryTotal,
      fixed,
      resolutionRate: summaryTotal > 0 ? Math.round((fixed / summaryTotal) * 100) : 0,
      byCategory: Object.fromEntries(byCategoryRaw.map((e) => [e.category, e._count])),
      byAction: Object.fromEntries(byActionRaw.map((e) => [e.action, e._count])),
    };

    return NextResponse.json({ entries, total, summary, projects });
  } catch (e) {
    console.error("[API/triage] GET error:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// PATCH — update resolution manually
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, resolution } = body;

    if (!id || !resolution) {
      return NextResponse.json({ error: "id and resolution required" }, { status: 400 });
    }

    if (!VALID_RESOLUTIONS.includes(resolution)) {
      return NextResponse.json(
        { error: `Invalid resolution. Must be one of: ${VALID_RESOLUTIONS.join(", ")}` },
        { status: 400 }
      );
    }

    const entry = await prisma.triageLog.update({
      where: { id },
      data: {
        resolution,
        ...(TERMINAL_RESOLUTIONS.includes(resolution) && { resolvedAt: new Date() }),
      },
      include: { project: { select: { name: true, jiraKey: true } } },
    });

    return NextResponse.json({ entry });
  } catch (e) {
    console.error("[API/triage] PATCH error:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

// POST — retry a triage entry with a chosen model, optionally with PO instructions
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, model, instructions } = body;

    if (!id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    // Either model or instructions must be provided
    if (!model && !instructions) {
      return NextResponse.json({ error: "model or instructions required" }, { status: 400 });
    }

    const effectiveModel = model || MODEL_OPTIONS[0];

    if (!MODEL_OPTIONS.includes(effectiveModel)) {
      return NextResponse.json(
        { error: `Invalid model. Must be one of: ${MODEL_OPTIONS.join(", ")}` },
        { status: 400 }
      );
    }

    const entry = await prisma.triageLog.findUnique({ where: { id } });
    if (!entry) {
      return NextResponse.json({ error: "Triage entry not found" }, { status: 404 });
    }

    // Build Jira comment based on whether PO instructions are provided
    let comment: string;
    if (instructions) {
      comment = `[PO INSTRUCTIONS] ${instructions}\n\nPrevious failure: ${entry.summary}\nSuggested fix: ${entry.suggestedFix}\nModel: ${effectiveModel}`;
    } else {
      comment = `[RETRY] Re-dispatching with model: ${effectiveModel}\nPrevious failure: ${entry.summary}\nSuggested fix: ${entry.suggestedFix}`;
    }

    await addComment(entry.ticketKey, comment).catch((e) =>
      console.error("[API/triage] Failed to add comment:", e)
    );

    // Transition ticket back to "To Do" for the dispatcher to pick up
    await transitionToStatus(entry.ticketKey, "To Do").catch((e) =>
      console.error("[API/triage] Failed to transition ticket:", e)
    );

    // Reset failure counts so dispatcher doesn't skip due to maxRetries
    await prisma.session.updateMany({
      where: { ticketKey: entry.ticketKey, projectId: entry.projectId, status: "failed" },
      data: { status: "cancelled" },
    });
    await prisma.qualityGateRun.updateMany({
      where: { ticketKey: entry.ticketKey, projectId: entry.projectId, passed: false },
      data: { passed: true },
    });

    // Update triage log
    const updated = await prisma.triageLog.update({
      where: { id },
      data: {
        resolution: "retrying",
        attemptCount: { increment: 1 },
      },
      include: { project: { select: { name: true, jiraKey: true } } },
    });

    // Start dispatcher if not running — a manual retry implies the PO wants the work done
    const dState = getDispatcherState();
    const wasStarted = !dState.running;
    if (wasStarted) {
      await startScheduler(); // Starts dispatcher + QA runner + all background tasks
    }

    // Trigger immediate dispatch + delayed retries in case _polling blocks the first attempt
    triggerDispatch();
    setTimeout(() => triggerDispatch(), 3000);
    setTimeout(() => triggerDispatch(), 8000);

    return NextResponse.json({
      entry: updated,
      dispatched: true,
      dispatcherStarted: wasStarted,
    });
  } catch (e) {
    console.error("[API/triage] POST error:", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
