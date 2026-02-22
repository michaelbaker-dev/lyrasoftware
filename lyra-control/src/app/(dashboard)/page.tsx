import { prisma } from "@/lib/db";
import AgentStatusPanel from "@/components/agent-status-panel";
import WorkQueue from "@/components/work-queue";
import CostTicker from "@/components/cost-ticker";
import ActivityFeed from "@/components/activity-feed";
import SystemHealth from "@/components/system-health";
import ProjectSelector from "@/components/project-selector";
import PipelineActivity from "@/components/pipeline-activity";

export const dynamic = "force-dynamic";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const { project: projectId } = await searchParams;

  const projects = await prisma.project.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
  });

  // Build project filter for queries
  const projectFilter = projectId ? { projectId } : {};

  // Fetch sessions to populate the work queue — deduplicated by ticket key.
  // Each ticket shows once, using the "best" session status:
  //   completed > running > failed/cancelled
  // This prevents retried tickets from appearing in multiple columns.
  const sessions = await prisma.session.findMany({
    where: projectFilter,
    include: { agent: true },
    orderBy: { startedAt: "desc" },
  });

  type Ticket = {
    key: string;
    summary: string;
    assignee: string;
    priority: string;
  };

  const tickets: {
    "To Do": Ticket[];
    "In Progress": Ticket[];
    "Code Review": Ticket[];
    Done: Ticket[];
  } = {
    "To Do": [],
    "In Progress": [],
    "Code Review": [],
    Done: [],
  };

  // Status priority: completed > running > failed/cancelled
  const STATUS_RANK: Record<string, number> = {
    completed: 3,
    running: 2,
    failed: 1,
    cancelled: 0,
  };

  // Group sessions by ticket key, keeping the best status
  const ticketMap = new Map<string, { status: string; rank: number; branch: string; agent: string }>();
  for (const s of sessions) {
    const rank = STATUS_RANK[s.status] ?? 0;
    const existing = ticketMap.get(s.ticketKey);
    if (!existing || rank > existing.rank) {
      ticketMap.set(s.ticketKey, {
        status: s.status,
        rank,
        branch: s.branch,
        agent: s.agent?.name || "Unassigned",
      });
    }
  }

  for (const [key, info] of ticketMap) {
    const ticket: Ticket = {
      key,
      summary: info.branch,
      assignee: info.agent,
      priority: "Medium",
    };

    switch (info.status) {
      case "running":
        tickets["In Progress"].push(ticket);
        break;
      case "completed":
        tickets["Done"].push(ticket);
        break;
      case "failed":
      case "cancelled":
        tickets["To Do"].push(ticket);
        break;
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Dashboard</h1>
        <div className="flex items-center gap-3">
          <ProjectSelector projects={projects} />
          <SystemHealth />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-6">
          <AgentStatusPanel />
          <WorkQueue tickets={tickets} />
          <PipelineActivity />
        </div>
        <div className="space-y-6">
          <CostTicker projectId={projectId} />
          <ActivityFeed />
        </div>
      </div>
    </div>
  );
}
