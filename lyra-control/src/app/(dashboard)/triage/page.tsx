"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "@/lib/api";

// ── Types ────────────────────────────────────────────────────────────

type TriageEntry = {
  id: string;
  projectId: string;
  ticketKey: string;
  ticketSummary: string | null;
  sessionId: string | null;
  source: string;
  category: string;
  action: string;
  summary: string;
  suggestedFix: string;
  rootCause: string | null;
  confidence: number;
  reassignTo: string | null;
  actionTaken: string;
  linkedBugKey: string | null;
  resolution: string;
  attemptCount: number;
  resolvedAt: string | null;
  createdAt: string;
  project: { name: string; jiraKey: string };
  session?: { output: string | null; status: string } | null;
};

type TriageSummary = {
  total: number;
  fixed: number;
  resolutionRate: number;
  byCategory: Record<string, number>;
  byAction: Record<string, number>;
};

type ProjectOption = {
  id: string;
  name: string;
  jiraKey: string;
};

// ── Constants ────────────────────────────────────────────────────────

const CATEGORY_COLORS: Record<string, string> = {
  build_error: "bg-red-900/30 text-red-400",
  runtime_crash: "bg-red-900/30 text-red-400",
  test_failure: "bg-yellow-900/30 text-yellow-400",
  type_error: "bg-orange-900/30 text-orange-400",
  lint_failure: "bg-blue-900/30 text-blue-400",
  env_issue: "bg-purple-900/30 text-purple-400",
  dependency_issue: "bg-orange-900/30 text-orange-400",
  timeout: "bg-yellow-900/30 text-yellow-400",
  unknown: "bg-gray-700/30 text-gray-400",
};

const RESOLUTION_COLORS: Record<string, string> = {
  open: "bg-red-900/30 text-red-400",
  retrying: "bg-yellow-900/30 text-yellow-400",
  fixed: "bg-green-900/30 text-green-400",
  wontfix: "bg-gray-700/30 text-gray-400",
  escalated: "bg-purple-900/30 text-purple-400",
};

const MODEL_OPTIONS = [
  { value: "claude-opus-4", label: "Claude Opus 4" },
  { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { value: "openrouter/auto", label: "OpenRouter/auto" },
];

const CATEGORIES = [
  "build_error", "test_failure", "runtime_crash", "type_error",
  "lint_failure", "env_issue", "dependency_issue", "timeout", "unknown",
];

const RESOLUTIONS = ["open", "retrying", "fixed", "wontfix", "escalated"];
const SOURCES = ["agent_failure", "slack_bug", "oversight_escalation", "oversight_context", "launch_validation"];

// ── Helpers ──────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function topCategory(byCategory: Record<string, number>): string {
  const entries = Object.entries(byCategory);
  if (entries.length === 0) return "—";
  entries.sort((a, b) => b[1] - a[1]);
  return entries[0][0].replace("_", " ");
}

// ── Component ────────────────────────────────────────────────────────

export default function TriagePage() {
  const [entries, setEntries] = useState<TriageEntry[]>([]);
  const [summary, setSummary] = useState<TriageSummary | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [retryDropdown, setRetryDropdown] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [instructions, setInstructions] = useState<Record<string, string>>({});
  const [instructionModel, setInstructionModel] = useState<Record<string, string>>({});

  // Filters
  const [filterProject, setFilterProject] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterResolution, setFilterResolution] = useState("");
  const [filterSource, setFilterSource] = useState("");

  const eventSourceRef = useRef<EventSource | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filterProject) params.set("projectId", filterProject);
      if (filterCategory) params.set("category", filterCategory);
      if (filterResolution) params.set("resolution", filterResolution);
      if (filterSource) params.set("source", filterSource);

      const res = await fetch(api(`/api/triage?${params.toString()}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setEntries(data.entries);
      setTotal(data.total);
      setSummary(data.summary);
      if (data.projects) setProjects(data.projects);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filterProject, filterCategory, filterResolution, filterSource]);

  useEffect(() => {
    load();
  }, [load]);

  // SSE — refresh on failure:analyzed events
  useEffect(() => {
    const es = new EventSource(api("/api/events"));
    eventSourceRef.current = es;

    es.addEventListener("failure:analyzed", () => {
      load();
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [load]);

  const handleResolution = async (id: string, resolution: string) => {
    setActionLoading(`res-${id}`);
    setError(null);
    try {
      const res = await fetch(api("/api/triage"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, resolution }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetry = async (id: string, model: string) => {
    setActionLoading(`retry-${id}`);
    setRetryDropdown(null);
    setError(null);
    try {
      const res = await fetch(api("/api/triage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleRetryWithInstructions = async (id: string) => {
    const text = instructions[id]?.trim();
    if (!text) return;
    setActionLoading(`instr-${id}`);
    setError(null);
    try {
      const model = instructionModel[id] || MODEL_OPTIONS[0].value;
      const res = await fetch(api("/api/triage"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, instructions: text, model }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setInstructions((prev) => ({ ...prev, [id]: "" }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionLoading(null);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-6">
        <h1 className="text-2xl font-bold">Triage Log</h1>
        <div className="text-gray-400 py-10 text-center">Loading triage entries...</div>
      </div>
    );
  }

  const openRetrying = entries.filter(
    (e) => e.resolution === "open" || e.resolution === "retrying"
  ).length;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Triage Log</h1>
          {total > 0 && (
            <span className="rounded-full bg-gray-700 px-2.5 py-0.5 text-sm font-medium text-gray-300">
              {total}
            </span>
          )}
        </div>
        <button
          onClick={() => { setLoading(true); load(); }}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800 cursor-pointer"
        >
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-4 gap-4">
          <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4">
            <div className="text-xs text-gray-500 uppercase tracking-wide">Total Failures</div>
            <div className="mt-1 text-2xl font-bold text-gray-200">{summary.total}</div>
          </div>
          <div className="rounded-lg border border-red-900/50 bg-gray-800/50 p-4">
            <div className="text-xs text-red-400 uppercase tracking-wide">Open Issues</div>
            <div className="mt-1 text-2xl font-bold text-red-400">{openRetrying}</div>
          </div>
          <div className="rounded-lg border border-green-900/50 bg-gray-800/50 p-4">
            <div className="text-xs text-green-400 uppercase tracking-wide">Resolution Rate</div>
            <div className="mt-1 text-2xl font-bold text-green-400">{summary.resolutionRate}%</div>
          </div>
          <div className="rounded-lg border border-yellow-900/50 bg-gray-800/50 p-4">
            <div className="text-xs text-yellow-400 uppercase tracking-wide">Top Category</div>
            <div className="mt-1 text-lg font-bold text-yellow-400 capitalize">
              {topCategory(summary.byCategory)}
            </div>
          </div>
        </div>
      )}

      {/* Filter Bar */}
      <div className="flex items-center gap-3">
        <select
          value={filterProject}
          onChange={(e) => setFilterProject(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">All Projects</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name} ({p.jiraKey})</option>
          ))}
        </select>
        <select
          value={filterCategory}
          onChange={(e) => setFilterCategory(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">All Categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c.replace("_", " ")}</option>
          ))}
        </select>
        <select
          value={filterResolution}
          onChange={(e) => setFilterResolution(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">All Resolutions</option>
          {RESOLUTIONS.map((r) => (
            <option key={r} value={r}>{r}</option>
          ))}
        </select>
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value)}
          className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm text-gray-300"
        >
          <option value="">All Sources</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
      </div>

      {/* Empty State */}
      {entries.length === 0 && (
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-8 text-center text-gray-400">
          No triage entries found. Entries appear here when agent failures are analyzed.
        </div>
      )}

      {/* Entry List */}
      <div className="space-y-3">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="rounded-lg border border-gray-700 bg-gray-900 p-4 space-y-3"
          >
            {/* Top row: ticket, summary, project, time, resolution */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <a
                  href={`https://mbakers.atlassian.net/browse/${entry.ticketKey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-sm font-medium text-blue-400 hover:text-blue-300"
                >
                  {entry.ticketKey}
                </a>
                <span className="text-xs text-gray-500">{entry.project.name}</span>
                <span className="text-xs text-gray-600">{relativeTime(entry.createdAt)}</span>
              </div>
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${RESOLUTION_COLORS[entry.resolution] || "bg-gray-700 text-gray-400"}`}
              >
                {entry.resolution}
              </span>
            </div>

            {/* Ticket summary */}
            {entry.ticketSummary && (
              <div className="border-l-2 border-gray-700 pl-3 text-sm italic text-gray-400">
                Task: {entry.ticketSummary}
              </div>
            )}

            {/* Badges row */}
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className={`rounded px-2 py-0.5 text-xs font-medium ${CATEGORY_COLORS[entry.category] || "bg-gray-700 text-gray-400"}`}
              >
                {entry.category.replace("_", " ")}
              </span>
              <span className="rounded bg-gray-700/50 px-2 py-0.5 text-xs text-gray-400">
                {entry.action.replace("_", " ")}
              </span>
              <span className="rounded bg-gray-700/30 px-2 py-0.5 text-xs text-gray-500">
                {entry.source.replace("_", " ")}
              </span>
              {entry.linkedBugKey && (
                <a
                  href={`https://mbakers.atlassian.net/browse/${entry.linkedBugKey}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded bg-red-900/20 px-2 py-0.5 text-xs text-red-400 hover:text-red-300"
                >
                  Bug: {entry.linkedBugKey}
                </a>
              )}
              {entry.reassignTo && (
                <span className="rounded bg-indigo-900/20 px-2 py-0.5 text-xs text-indigo-400">
                  reassign: {entry.reassignTo}
                </span>
              )}
              {entry.attemptCount > 1 && (
                <span className="text-xs text-gray-500">attempt #{entry.attemptCount}</span>
              )}
            </div>

            {/* Action taken */}
            {entry.actionTaken && (
              <div className="text-xs text-gray-500">
                <span className="text-gray-600">Action taken:</span> {entry.actionTaken}
              </div>
            )}

            {/* Summary */}
            <div className="text-sm text-gray-300">{entry.summary}</div>

            {/* Suggested fix (expandable) */}
            <details className="text-sm">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-300">
                Suggested fix
              </summary>
              <div className="mt-1 rounded bg-gray-800 p-2 text-gray-400">
                {entry.suggestedFix}
              </div>
            </details>

            {/* Root cause + confidence */}
            {entry.rootCause && (
              <div className="text-xs text-gray-500">
                <span className="text-gray-600">Root cause:</span> {entry.rootCause}
              </div>
            )}

            {/* Confidence bar */}
            <div className="flex items-center gap-2">
              <span className="text-xs text-gray-600">Confidence:</span>
              <div className="h-1.5 flex-1 max-w-32 rounded-full bg-gray-700">
                <div
                  className="h-1.5 rounded-full bg-blue-500"
                  style={{ width: `${Math.round(entry.confidence * 100)}%` }}
                />
              </div>
              <span className="text-xs text-gray-500">
                {Math.round(entry.confidence * 100)}%
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-2 pt-1">
              {/* Retry — only for non-fixed/non-wontfix */}
              {["open", "retrying", "escalated"].includes(entry.resolution) && (
                <div className="relative">
                  <button
                    onClick={() =>
                      setRetryDropdown(retryDropdown === entry.id ? null : entry.id)
                    }
                    disabled={actionLoading === `retry-${entry.id}`}
                    className="rounded border border-blue-700 px-2.5 py-1 text-xs text-blue-400 hover:bg-blue-900/20 disabled:opacity-50 cursor-pointer"
                  >
                    {actionLoading === `retry-${entry.id}` ? "Retrying..." : "Retry"}
                  </button>
                  {retryDropdown === entry.id && (
                    <div className="absolute left-0 top-full z-10 mt-1 rounded-lg border border-gray-700 bg-gray-800 p-1 shadow-lg">
                      {MODEL_OPTIONS.map((m) => (
                        <button
                          key={m.value}
                          onClick={() => handleRetry(entry.id, m.value)}
                          className="block w-full rounded px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-gray-700 cursor-pointer whitespace-nowrap"
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {entry.resolution !== "fixed" && (
                <button
                  onClick={() => handleResolution(entry.id, "fixed")}
                  disabled={actionLoading === `res-${entry.id}`}
                  className="rounded border border-green-700 px-2.5 py-1 text-xs text-green-400 hover:bg-green-900/20 disabled:opacity-50 cursor-pointer"
                >
                  Mark Fixed
                </button>
              )}

              {entry.resolution !== "wontfix" && entry.resolution !== "fixed" && (
                <button
                  onClick={() => handleResolution(entry.id, "wontfix")}
                  disabled={actionLoading === `res-${entry.id}`}
                  className="rounded border border-gray-600 px-2.5 py-1 text-xs text-gray-400 hover:bg-gray-700 disabled:opacity-50 cursor-pointer"
                >
                  Won&apos;t Fix
                </button>
              )}
            </div>

            {/* Agent Output — visible for open/retrying, collapsed for resolved */}
            {entry.session?.output && (
              (entry.resolution === "open" || entry.resolution === "retrying") ? (
                <div className="text-sm space-y-1">
                  <div className="text-xs text-gray-500">Agent Output</div>
                  <pre className="max-h-60 overflow-auto rounded bg-gray-800 p-2 text-xs text-gray-400 font-mono whitespace-pre-wrap">
                    {entry.session.output.slice(-1500)}
                  </pre>
                  {entry.session.output.length > 1500 && (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-gray-600 hover:text-gray-400">
                        Show full output ({Math.round(entry.session.output.length / 1000)}k chars)
                      </summary>
                      <pre className="mt-1 max-h-96 overflow-auto rounded bg-gray-800 p-2 text-xs text-gray-400 font-mono whitespace-pre-wrap">
                        {entry.session.output}
                      </pre>
                    </details>
                  )}
                </div>
              ) : (
                <details className="text-sm">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-300">
                    Agent Output (last 3000 chars)
                  </summary>
                  <pre className="mt-1 max-h-80 overflow-auto rounded bg-gray-800 p-2 text-xs text-gray-400 font-mono whitespace-pre-wrap">
                    {entry.session.output.slice(-3000)}
                  </pre>
                </details>
              )
            )}

            {/* Re-dispatch with Instructions */}
            {["open", "retrying", "escalated"].includes(entry.resolution) && (
              <div className="space-y-2 border-t border-gray-800 pt-3">
                <textarea
                  rows={2}
                  value={instructions[entry.id] || ""}
                  onChange={(e) =>
                    setInstructions((prev) => ({ ...prev, [entry.id]: e.target.value }))
                  }
                  placeholder="Add instructions for the agent..."
                  className="w-full rounded border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-300 placeholder-gray-600 resize-y"
                />
                <div className="flex items-center gap-2">
                  <select
                    value={instructionModel[entry.id] || MODEL_OPTIONS[0].value}
                    onChange={(e) =>
                      setInstructionModel((prev) => ({ ...prev, [entry.id]: e.target.value }))
                    }
                    className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs text-gray-300"
                  >
                    {MODEL_OPTIONS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => handleRetryWithInstructions(entry.id)}
                    disabled={
                      !instructions[entry.id]?.trim() ||
                      actionLoading === `instr-${entry.id}`
                    }
                    className="rounded border border-purple-700 px-2.5 py-1 text-xs text-purple-400 hover:bg-purple-900/20 disabled:opacity-50 cursor-pointer"
                  >
                    {actionLoading === `instr-${entry.id}`
                      ? "Dispatching..."
                      : "Re-dispatch with Instructions"}
                  </button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
