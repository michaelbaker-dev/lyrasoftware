import { NextResponse } from "next/server";
import { getState, updateConfig, triggerDispatch } from "@/lib/dispatcher";
import { startScheduler, stopScheduler, getSchedulerState } from "@/lib/scheduler";

export async function GET() {
  const dispatcher = getState();
  const scheduler = getSchedulerState();
  return NextResponse.json({ ...dispatcher, scheduler });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { action, config } = body;

  switch (action) {
    case "start":
      await startScheduler();
      return NextResponse.json({ status: "started" });
    case "stop":
      stopScheduler();
      return NextResponse.json({ status: "stopped" });
    case "restart":
      stopScheduler();
      await startScheduler();
      return NextResponse.json({ status: "restarted" });
    case "trigger":
      triggerDispatch();
      return NextResponse.json({ status: "dispatch_triggered" });
    case "oversight":
      import("@/lib/lyra-oversight").then((m) => m.runOversightCheck());
      return NextResponse.json({ status: "oversight_triggered" });
    case "config":
      updateConfig(config);
      return NextResponse.json({ status: "updated", config });
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
