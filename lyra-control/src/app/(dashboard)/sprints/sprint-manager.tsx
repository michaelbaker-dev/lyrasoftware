"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import ModelSelector from "@/components/model-selector";
import SprintDemo from "./sprint-demo";
import { api } from "@/lib/api";

type SprintData = {
  id: string;
  name: string;
  goal: string | null;
  state: string;
  plannedPoints: number;
  completedPoints: number;
  startDate: string | null;
  endDate: string | null;
};

type SprintTicket = {
  key: string;
  summary: string;
  status: string;
  statusCategory: string;
  points: number;
  issuetype: string;
  hasRunningAgent: boolean;
  blockedBy: string[];
};

type TeamGap = {
  role: string;
  label: string;
  storiesRequiring: number;
  agentsAvailable: number;
  severity: "critical" | "warning";
};

type SprintManagerProps = {
  projectId: string;
  projectName: string;
  jiraKey: string;
  velocityTarget: number;
  sprintLength: number;
  activeSprintId: number | null;
  breakdownReady: boolean;
  breakdownStoryCount: number;
  initialSprints: SprintData[];
  initialTickets: SprintTicket[];
};

function stateColor(state: string): string {
  switch (state) {
    case "active": return "bg-green-900/30 text-green-400 border-green-800";
    case "closed": return "bg-gray-900/30 text-gray-400 border-gray-700";
    default: return "bg-blue-900/30 text-blue-400 border-blue-800";
  }
}

function daysRemaining(endDate: string | null): number | null {
  if (!endDate) return null;
  const diff = new Date(endDate).getTime() - Date.now();
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)));
}

export default function SprintManager({
  projectId,
  projectName,
  jiraKey,
  velocityTarget,
  sprintLength,
  activeSprintId,
  breakdownReady,
  breakdownStoryCount,
  initialSprints,
  initialTickets,
}: SprintManagerProps) {
  const [sprints, setSprints] = useState<SprintData[]>(initialSprints);
  const [tickets, setTickets] = useState<SprintTicket[]>(initialTickets);
  const [ticketsExpanded, setTicketsExpanded] = useState(true);
  const [ticketActionLoading, setTicketActionLoading] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPlanForm, setShowPlanForm] = useState(false);
  const [sprintName, setSprintName] = useState("");
  const [sprintGoal, setSprintGoal] = useState("");
  const [planModel, setPlanModel] = useState("openrouter/auto");
  const [planResult, setPlanResult] = useState<{ selectedKeys: string[]; reasoning: string } | null>(null);
  const [teamGaps, setTeamGaps] = useState<TeamGap[]>([]);
  const [gapResolving, setGapResolving] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [demoData, setDemoData] = useState<any>(null);
  const [demoSprintId, setDemoSprintId] = useState<string | null>(null);
  const [demoLoading, setDemoLoading] = useState(false);
  const [mergeLoading, setMergeLoading] = useState(false);
  const [mergeResults, setMergeResults] = useState<{
    results: Array<{ pr: number; ticketKey: string | null; title: string; status: string; message: string }>;
    merged: number; skipped: number; conflicts: number; errors: number;
  } | null>(null);
  const [redispatchLoading, setRedispatchLoading] = useState(false);
  const [redispatchResults, setRedispatchResults] = useState<{
    results: Array<{ pr: number; ticketKey: string | null; step: string; success: boolean; error?: string; sessionId?: string }>;
  } | null>(null);
  const [populatingBacklog, setPopulatingBacklog] = useState(false);
  const [populateResult, setPopulateResult] = useState<{ created: number } | null>(null);
  const router = useRouter();

  const hasCriticalGaps = teamGaps.some((g) => g.severity === "critical");

  const handleCreateAgent = async (role: string) => {
    setGapResolving(role);
    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-agent", projectId, role }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Remove the resolved gap
      setTeamGaps((prev) =>
        prev.filter((g) => g.role !== role)
      );
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setGapResolving(null);
    }
  };

  const handlePopulateBacklog = async () => {
    setPopulatingBacklog(true);
    setError(null);
    setPopulateResult(null);
    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "populate-backlog", projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPopulateResult({ created: data.created });
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPopulatingBacklog(false);
    }
  };

  const handleTicketAction = async (action: "force-resolve" | "kill-agent" | "retry-ticket", ticketKey: string) => {
    setTicketActionLoading(ticketKey);
    setError(null);
    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, projectId, ticketKey }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Update local ticket state
      setTickets((prev) =>
        prev.map((t) => {
          if (t.key === ticketKey) {
            if (action === "force-resolve") {
              return { ...t, status: "Done", statusCategory: "done", hasRunningAgent: false };
            }
            if (action === "kill-agent") {
              return { ...t, status: "To Do", statusCategory: "new", hasRunningAgent: false };
            }
            if (action === "retry-ticket") {
              return { ...t, status: "In Progress", statusCategory: "indeterminate", hasRunningAgent: true };
            }
          }
          // If force-resolving a blocker, update dependents
          if (action === "force-resolve") {
            return {
              ...t,
              blockedBy: t.blockedBy.filter((b) => b !== ticketKey),
            };
          }
          return t;
        })
      );
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setTicketActionLoading(null);
    }
  };

  const activeSprint = sprints.find((s) => s.state === "active");
  const futureSprints = sprints.filter((s) => s.state === "future");
  const closedSprints = sprints.filter((s) => s.state === "closed");

  const handlePlan = async () => {
    setLoading(true);
    setError(null);
    setPlanResult(null);

    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "plan",
          projectId,
          sprintName: sprintName || `${jiraKey} Sprint ${sprints.length + 1}`,
          goal: sprintGoal || undefined,
          model: planModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setPlanResult({
        selectedKeys: data.sprint.selectedKeys,
        reasoning: data.sprint.reasoning,
      });
      setTeamGaps(data.gaps || []);

      // Refresh sprints
      const listRes = await fetch(api(`/api/sprints?projectId=${projectId}`));
      const listData = await listRes.json();
      setSprints(listData.sprints);
      setShowPlanForm(false);
      setSprintName("");
      setSprintGoal("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleAction = async (action: "start" | "complete", sprintId: string) => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, sprintId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Refresh sprints
      const listRes = await fetch(api(`/api/sprints?projectId=${projectId}`));
      const listData = await listRes.json();
      setSprints(listData.sprints);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleDemo = async (sprintId: string) => {
    if (demoSprintId === sprintId) {
      setDemoSprintId(null);
      setDemoData(null);
      return;
    }
    setDemoLoading(true);
    setDemoSprintId(sprintId);
    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "demo", projectId, sprintId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setDemoData(data);
    } catch (e) {
      setError((e as Error).message);
      setDemoSprintId(null);
    } finally {
      setDemoLoading(false);
    }
  };

  const handleMergeQueue = async () => {
    setMergeLoading(true);
    setMergeResults(null);
    setError(null);
    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merge-all", projectId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setMergeResults(data);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMergeLoading(false);
    }
  };

  const handleRedispatchConflicts = async () => {
    if (!mergeResults) return;
    const conflictPRs = mergeResults.results
      .filter((r) => r.status === "conflict")
      .map((r) => ({ pr: r.pr, ticketKey: r.ticketKey }));
    if (conflictPRs.length === 0) return;

    setRedispatchLoading(true);
    setRedispatchResults(null);
    setError(null);
    try {
      const res = await fetch(api("/api/sprints"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "resolve-conflicts", projectId, conflictPRs }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRedispatchResults(data);
      setMergeResults(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRedispatchLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Populate Backlog from Breakdown */}
      {breakdownReady && !populateResult && (
        <div className="rounded-lg border border-blue-800 bg-blue-900/20 p-4 space-y-2">
          <p className="text-sm font-medium text-blue-300">
            Work breakdown ready — {breakdownStoryCount} {breakdownStoryCount === 1 ? "story" : "stories"} not yet in Jira
          </p>
          <p className="text-xs text-gray-400">
            Your approved work breakdown has stories ready but they haven&apos;t been created as Jira tickets yet.
            Create them now so you can plan a sprint.
          </p>
          <button
            onClick={handlePopulateBacklog}
            disabled={populatingBacklog}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors cursor-pointer"
          >
            {populatingBacklog ? "Creating Jira Tickets..." : "Create Jira Tickets from Breakdown"}
          </button>
        </div>
      )}

      {populateResult && (
        <div className="rounded-lg border border-green-800 bg-green-900/20 p-3 text-sm text-green-300">
          Successfully created {populateResult.created} Jira tickets from your work breakdown. You can now plan a sprint.
        </div>
      )}

      {/* Active Sprint Card */}
      {activeSprint && (
        <div className="rounded-lg border border-green-800 bg-gray-800/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium border ${stateColor("active")}`}>
                  Active
                </span>
                <h3 className="font-semibold text-white">{activeSprint.name}</h3>
              </div>
              {activeSprint.goal && (
                <p className="mt-1 text-sm text-gray-400">{activeSprint.goal}</p>
              )}
            </div>
            {activeSprint.endDate && (
              <div className="text-right">
                <div className="text-lg font-bold text-white">
                  {daysRemaining(activeSprint.endDate)}
                </div>
                <div className="text-xs text-gray-400">days left</div>
              </div>
            )}
          </div>

          {/* Progress bar */}
          <div>
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>{activeSprint.completedPoints} completed</span>
              <span>{activeSprint.plannedPoints} planned</span>
            </div>
            <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-green-500 rounded-full transition-all"
                style={{
                  width: `${activeSprint.plannedPoints > 0 ? Math.min(100, (activeSprint.completedPoints / activeSprint.plannedPoints) * 100) : 0}%`,
                }}
              />
            </div>
          </div>

          <div className="flex gap-2">
            <button
              onClick={() => handleDemo(activeSprint.id)}
              disabled={demoLoading}
              className="rounded-lg border border-purple-700 px-3 py-1.5 text-sm text-purple-300 hover:bg-purple-900/30 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {demoLoading && demoSprintId === activeSprint.id ? "Loading..." : "Sprint Demo"}
            </button>
            <button
              onClick={() => handleAction("complete", activeSprint.id)}
              disabled={loading}
              className="rounded-lg border border-gray-600 px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 disabled:opacity-50 transition-colors cursor-pointer"
            >
              Complete Sprint
            </button>
          </div>

          {demoSprintId === activeSprint.id && demoData && (
            <SprintDemo
              data={demoData}
              projectId={projectId}
              sprintId={activeSprint.id}
              onClose={() => { setDemoSprintId(null); setDemoData(null); }}
            />
          )}

          {/* Sprint Tickets */}
          {tickets.length > 0 && (
            <div className="border-t border-gray-700 pt-3">
              <button
                onClick={() => setTicketsExpanded(!ticketsExpanded)}
                className="flex items-center gap-2 text-sm font-medium text-gray-300 hover:text-white transition-colors cursor-pointer w-full text-left"
              >
                <span className={`transition-transform ${ticketsExpanded ? "rotate-90" : ""}`}>&#9654;</span>
                Sprint Tickets ({tickets.length} {tickets.length === 1 ? "story" : "stories"})
                <span className="text-xs text-gray-500 ml-auto">
                  {tickets.filter((t) => t.statusCategory === "done").length} done
                  {tickets.some((t) => t.hasRunningAgent) &&
                    ` · ${tickets.filter((t) => t.hasRunningAgent).length} running`}
                </span>
              </button>

              {ticketsExpanded && (
                <div className="mt-2 space-y-1 max-h-96 overflow-auto">
                  {tickets.map((ticket) => {
                    const isDone = ticket.statusCategory === "done";
                    const isInProgress = ticket.statusCategory === "indeterminate" || ticket.hasRunningAgent;
                    const isBlocked = ticket.blockedBy.length > 0 && !isDone && !isInProgress;
                    const isTodo = !isDone && !isInProgress;

                    const statusBadgeClass = isDone
                      ? "bg-green-900/30 text-green-400"
                      : isInProgress
                      ? "bg-yellow-900/30 text-yellow-400"
                      : isBlocked
                      ? "bg-gray-900/30 text-gray-500"
                      : "bg-blue-900/30 text-blue-400";

                    const isActionLoading = ticketActionLoading === ticket.key;

                    return (
                      <div key={ticket.key} className="rounded-lg border border-gray-700/50 bg-gray-900/30 p-2.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-xs text-purple-400 shrink-0">{ticket.key}</span>
                            <span className="text-sm text-gray-200 truncate">{ticket.summary}</span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusBadgeClass}`}>
                              {ticket.status}
                            </span>
                            {ticket.points > 0 && (
                              <span className="text-xs text-gray-500">{ticket.points}pts</span>
                            )}
                          </div>
                        </div>

                        {/* Blocker info */}
                        {isBlocked && (
                          <div className="mt-1 text-xs text-gray-500 pl-1">
                            &#8627; blocked by {ticket.blockedBy.join(", ")}
                          </div>
                        )}

                        {/* Action buttons */}
                        {!isDone && (
                          <div className="mt-2 flex gap-1.5">
                            {isInProgress && ticket.hasRunningAgent && (
                              <>
                                <button
                                  onClick={() => handleTicketAction("kill-agent", ticket.key)}
                                  disabled={isActionLoading}
                                  className="rounded border border-red-800/50 px-2 py-0.5 text-xs text-red-400 hover:bg-red-900/20 disabled:opacity-50 transition-colors cursor-pointer"
                                >
                                  {isActionLoading ? "..." : "Kill & Retry"}
                                </button>
                                <button
                                  onClick={() => handleTicketAction("force-resolve", ticket.key)}
                                  disabled={isActionLoading}
                                  className="rounded border border-green-800/50 px-2 py-0.5 text-xs text-green-400 hover:bg-green-900/20 disabled:opacity-50 transition-colors cursor-pointer"
                                >
                                  {isActionLoading ? "..." : "Force Done"}
                                </button>
                              </>
                            )}
                            {isTodo && !isBlocked && (
                              <>
                                <button
                                  onClick={() => handleTicketAction("retry-ticket", ticket.key)}
                                  disabled={isActionLoading}
                                  className="rounded border border-blue-800/50 px-2 py-0.5 text-xs text-blue-400 hover:bg-blue-900/20 disabled:opacity-50 transition-colors cursor-pointer"
                                >
                                  {isActionLoading ? "..." : "Retry Now"}
                                </button>
                                <button
                                  onClick={() => handleTicketAction("force-resolve", ticket.key)}
                                  disabled={isActionLoading}
                                  className="rounded border border-green-800/50 px-2 py-0.5 text-xs text-green-400 hover:bg-green-900/20 disabled:opacity-50 transition-colors cursor-pointer"
                                >
                                  {isActionLoading ? "..." : "Force Done"}
                                </button>
                              </>
                            )}
                            {isTodo && isBlocked && (
                              <button
                                onClick={() => handleTicketAction("force-resolve", ticket.key)}
                                disabled={isActionLoading}
                                className="rounded border border-green-800/50 px-2 py-0.5 text-xs text-green-400 hover:bg-green-900/20 disabled:opacity-50 transition-colors cursor-pointer"
                              >
                                {isActionLoading ? "..." : "Force Done"}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Merge Queue */}
      {activeSprint && (
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-medium text-gray-300">Merge Queue</h3>
              <p className="text-xs text-gray-500">
                Merges completed PRs in dependency order, rebasing and resolving Jira issues automatically.
              </p>
            </div>
            <button
              onClick={handleMergeQueue}
              disabled={mergeLoading}
              className="rounded-lg bg-purple-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {mergeLoading ? "Merging..." : "Merge Completed PRs"}
            </button>
          </div>

          {mergeResults && (
            <div className="space-y-2">
              <div className="flex gap-3 text-xs">
                {mergeResults.merged > 0 && (
                  <span className="text-green-400">{mergeResults.merged} merged</span>
                )}
                {mergeResults.conflicts > 0 && (
                  <span className="text-yellow-400">{mergeResults.conflicts} conflicts</span>
                )}
                {mergeResults.errors > 0 && (
                  <span className="text-red-400">{mergeResults.errors} errors</span>
                )}
                {mergeResults.skipped > 0 && (
                  <span className="text-gray-400">{mergeResults.skipped} skipped</span>
                )}
              </div>
              <div className="space-y-1 max-h-48 overflow-auto">
                {mergeResults.results.map((r) => (
                  <div
                    key={r.pr}
                    className={`flex items-center justify-between rounded p-2 text-xs ${
                      r.status === "merged"
                        ? "bg-green-900/20 text-green-300"
                        : r.status === "conflict"
                        ? "bg-yellow-900/20 text-yellow-300"
                        : r.status === "skipped"
                        ? "bg-gray-900/20 text-gray-400"
                        : "bg-red-900/20 text-red-300"
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-mono shrink-0">#{r.pr}</span>
                      {r.ticketKey && (
                        <span className="shrink-0 text-purple-400">{r.ticketKey}</span>
                      )}
                      <span className="truncate">{r.title}</span>
                    </div>
                    <span className="shrink-0 ml-2">
                      {r.status === "merged" ? "Merged" : r.status === "conflict" ? "Conflict" : r.status === "skipped" ? "Skipped" : "Error"}
                    </span>
                  </div>
                ))}
              </div>
              {mergeResults.conflicts > 0 && (
                <div className="border-t border-gray-700 pt-3 space-y-2">
                  <button
                    onClick={handleRedispatchConflicts}
                    disabled={redispatchLoading}
                    className="rounded-lg bg-yellow-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-yellow-500 disabled:opacity-50 transition-colors cursor-pointer"
                  >
                    {redispatchLoading
                      ? "Re-dispatching..."
                      : `Re-dispatch ${mergeResults.conflicts} Conflicting PR${mergeResults.conflicts !== 1 ? "s" : ""}`}
                  </button>
                  <p className="text-xs text-gray-500">
                    Closes conflicting PRs, deletes stale branches, and spawns fresh agents from updated main.
                  </p>
                </div>
              )}
            </div>
          )}

          {redispatchResults && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-yellow-300">Re-dispatch Results</p>
              <div className="space-y-1 max-h-48 overflow-auto">
                {redispatchResults.results.map((r) => (
                  <div
                    key={r.pr}
                    className={`rounded p-2 text-xs ${
                      r.success ? "bg-green-900/20 text-green-300" : "bg-red-900/20 text-red-300"
                    }`}
                  >
                    <span className="font-mono">#{r.pr}</span>
                    {r.ticketKey && <span className="ml-2 text-purple-400">{r.ticketKey}</span>}
                    <span className="ml-2">
                      {r.success
                        ? r.step === "redispatched"
                          ? "Closed + agent spawned"
                          : "Closed (no ticket)"
                        : `Failed at ${r.step}: ${r.error}`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Future Sprints */}
      {futureSprints.map((sprint) => (
        <div key={sprint.id} className="rounded-lg border border-blue-800/50 bg-gray-800/50 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-medium border ${stateColor("future")}`}>
                Planned
              </span>
              <span className="font-medium text-white">{sprint.name}</span>
              <span className="text-sm text-gray-400">{sprint.plannedPoints} pts</span>
            </div>
            <button
              onClick={() => handleAction("start", sprint.id)}
              disabled={loading || !!activeSprint || hasCriticalGaps}
              title={hasCriticalGaps ? "Resolve critical team gaps before starting" : undefined}
              className="rounded-lg bg-green-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors cursor-pointer"
            >
              Start Sprint
            </button>
          </div>
          {sprint.goal && <p className="mt-1 text-sm text-gray-400">{sprint.goal}</p>}
        </div>
      ))}

      {/* Plan Result */}
      {planResult && (
        <div className="rounded-lg border border-purple-800/50 bg-purple-900/10 p-3 text-sm">
          <p className="font-medium text-purple-300 mb-1">Sprint planned successfully</p>
          <p className="text-gray-400">{planResult.reasoning}</p>
          <p className="text-gray-500 mt-1">Stories: {planResult.selectedKeys.join(", ")}</p>
        </div>
      )}

      {/* Team Gap Warnings */}
      {teamGaps.length > 0 && (
        <div className="space-y-2">
          {teamGaps.filter((g) => g.severity === "critical").map((gap) => (
            <div key={gap.role} className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm flex items-center justify-between">
              <div>
                <p className="font-medium text-red-300">
                  Missing {gap.label} agent
                </p>
                <p className="text-red-400/80 text-xs mt-0.5">
                  Sprint requires {gap.storiesRequiring} {gap.label.toLowerCase()} {gap.storiesRequiring === 1 ? "story" : "stories"} but your team has no {gap.label.toLowerCase()} agents.
                </p>
              </div>
              <button
                onClick={() => handleCreateAgent(gap.role)}
                disabled={gapResolving === gap.role}
                className="shrink-0 ml-3 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {gapResolving === gap.role ? "Creating..." : "Create Agent"}
              </button>
            </div>
          ))}
          {teamGaps.filter((g) => g.severity === "warning").map((gap) => (
            <div key={gap.role} className="rounded-lg border border-yellow-800/50 bg-yellow-900/10 p-3 text-sm flex items-center justify-between">
              <div>
                <p className="font-medium text-yellow-300">
                  {gap.label} agents may be understaffed
                </p>
                <p className="text-yellow-400/80 text-xs mt-0.5">
                  Sprint has {gap.storiesRequiring} {gap.label.toLowerCase()} {gap.storiesRequiring === 1 ? "story" : "stories"} but only {gap.agentsAvailable} {gap.agentsAvailable === 1 ? "agent" : "agents"}.
                </p>
              </div>
              <button
                onClick={() => handleCreateAgent(gap.role)}
                disabled={gapResolving === gap.role}
                className="shrink-0 ml-3 rounded-lg border border-yellow-700 px-3 py-1.5 text-xs text-yellow-300 hover:bg-yellow-900/30 disabled:opacity-50 transition-colors cursor-pointer"
              >
                {gapResolving === gap.role ? "Adding..." : "Add Agent"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Plan Sprint Button / Form */}
      {!showPlanForm ? (
        <button
          onClick={() => setShowPlanForm(true)}
          disabled={loading}
          className="w-full rounded-lg border border-dashed border-gray-600 px-4 py-3 text-sm text-gray-400 hover:border-purple-500 hover:text-purple-400 transition-colors cursor-pointer"
        >
          + Plan Next Sprint
        </button>
      ) : (
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4 space-y-3">
          <h3 className="font-medium text-white">Plan New Sprint</h3>
          <div>
            <label className="text-xs text-gray-400">Sprint Name</label>
            <input
              type="text"
              value={sprintName}
              onChange={(e) => setSprintName(e.target.value)}
              placeholder={`${jiraKey} Sprint ${sprints.length + 1}`}
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400">Sprint Goal (optional)</label>
            <input
              type="text"
              value={sprintGoal}
              onChange={(e) => setSprintGoal(e.target.value)}
              placeholder="e.g. Complete authentication and user management"
              className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm text-gray-200"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400">AI Model</label>
            <div className="mt-1">
              <ModelSelector
                value={planModel}
                onChange={setPlanModel}
                compact
                persistKey="sprint_plan"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handlePlan}
              disabled={loading}
              className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors cursor-pointer"
            >
              {loading ? "Planning..." : "AI Plan Sprint"}
            </button>
            <button
              onClick={() => setShowPlanForm(false)}
              className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors cursor-pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Sprint History / Velocity */}
      {closedSprints.length > 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-medium text-gray-300">Sprint History</h3>
          <div className="space-y-2">
            {closedSprints.map((sprint) => (
              <div key={sprint.id} className="space-y-2">
                <div className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800/30 p-3">
                  <div>
                    <span className="text-sm text-gray-200">{sprint.name}</span>
                    {sprint.startDate && sprint.endDate && (
                      <span className="ml-2 text-xs text-gray-500">
                        {new Date(sprint.startDate).toLocaleDateString()} — {new Date(sprint.endDate).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => handleDemo(sprint.id)}
                      disabled={demoLoading}
                      className="rounded border border-purple-800 px-2 py-1 text-xs text-purple-400 hover:bg-purple-900/20 disabled:opacity-50 cursor-pointer"
                    >
                      Demo
                    </button>
                    <div className="text-right">
                      <span className="text-sm font-bold text-white">{sprint.completedPoints}</span>
                      <span className="text-xs text-gray-500"> / {sprint.plannedPoints} pts</span>
                    </div>
                    <div className="w-20 h-2 bg-gray-700 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{
                          width: `${sprint.plannedPoints > 0 ? Math.min(100, (sprint.completedPoints / sprint.plannedPoints) * 100) : 0}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
                {demoSprintId === sprint.id && demoData && (
                  <SprintDemo
                    data={demoData}
                    projectId={projectId}
                    sprintId={sprint.id}
                    onClose={() => { setDemoSprintId(null); setDemoData(null); }}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Velocity average */}
          {closedSprints.length >= 2 && (
            <div className="text-xs text-gray-500">
              Average velocity: {Math.round(closedSprints.reduce((s, sp) => s + sp.completedPoints, 0) / closedSprints.length)} pts/sprint
            </div>
          )}
        </div>
      )}
    </div>
  );
}
