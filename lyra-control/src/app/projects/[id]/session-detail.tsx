"use client";

import { useEffect, useState, useCallback } from "react";

type GateRun = {
  id: string;
  passed: boolean;
  checks: string;
  reasoning: string;
  createdAt: string;
};

type TriageLog = {
  id: string;
  category: string;
  summary: string;
  rootCause: string | null;
  suggestedFix: string;
  resolution: string;
  linkedBugKey: string | null;
  createdAt: string;
};

type SessionAgent = {
  id: string;
  name: string;
  role: string;
  team?: { id: string; name: string } | null;
};

type SessionDetail = {
  id: string;
  ticketKey: string;
  branch: string;
  status: string;
  tokensUsed: number;
  cost: number;
  startedAt: string;
  completedAt: string | null;
  output: string | null;
  prompt: string | null;
  agent: SessionAgent;
  gateRuns: GateRun[];
  triageLogs: TriageLog[];
};

type AttemptSummary = {
  id: string;
  ticketKey: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  cost: number;
  agent: { id: string; name: string; role: string };
  gateRuns: { passed: boolean }[];
};

const statusColor: Record<string, string> = {
  running: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
  failed: "bg-red-500/20 text-red-400 border-red-500/30",
  cancelled: "bg-gray-500/20 text-gray-400 border-gray-500/30",
};

const roleColor: Record<string, string> = {
  dev: "text-blue-400",
  qa: "text-purple-400",
  architect: "text-amber-400",
  security: "text-red-400",
  docs: "text-green-400",
};

function formatDate(date: string | null | undefined): string {
  if (!date) return "\u2014";
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(start: string, end: string | null): string {
  if (!end) return "running...";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatCost(cost: number): string {
  if (cost < 0.01) return cost > 0 ? "<$0.01" : "$0.00";
  return `$${cost.toFixed(2)}`;
}

export default function SessionDetail({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [attempts, setAttempts] = useState<AttemptSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState(sessionId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showFullOutput, setShowFullOutput] = useState(false);
  const [retryPrompt, setRetryPrompt] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  const fetchSession = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${id}`);
      if (!res.ok) throw new Error("Failed to load session");
      const data = await res.json();
      setSession(data.session);
      setAttempts(data.attempts);
      setRetryPrompt(data.session.prompt || "");
      setShowFullOutput(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSession(activeSessionId);
  }, [activeSessionId, fetchSession]);

  const handleRetry = async () => {
    if (!session) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/sessions/${session.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: retryPrompt || undefined }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Retry failed");
      }
      const data = await res.json();
      // Refresh attempts and switch to new session
      setActiveSessionId(data.sessionId);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  };

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const currentAttemptIndex = attempts.findIndex((a) => a.id === activeSessionId);
  const attemptNumber = currentAttemptIndex + 1;

  const outputText = session?.output || "";
  const outputTruncated = outputText.length > 3000;
  const displayOutput = showFullOutput ? outputText : outputText.slice(-3000);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl my-8 rounded-xl border border-gray-700 bg-gray-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {loading && (
          <div className="flex items-center justify-center p-12">
            <span className="text-gray-400">Loading session...</span>
          </div>
        )}

        {error && (
          <div className="p-6">
            <p className="text-red-400">{error}</p>
            <button onClick={onClose} className="mt-4 text-sm text-gray-400 hover:text-gray-200">
              Close
            </button>
          </div>
        )}

        {session && !loading && (
          <div className="divide-y divide-gray-800">
            {/* Header */}
            <div className="p-5">
              <div className="flex items-start justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-3">
                    <h2 className="text-lg font-bold text-blue-400">{session.ticketKey}</h2>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${statusColor[session.status] ?? "text-gray-400"}`}
                    >
                      {session.status}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-sm text-gray-400">
                    <span>
                      {session.agent.name}{" "}
                      <span className={`${roleColor[session.agent.role] ?? "text-gray-400"}`}>
                        ({session.agent.role})
                      </span>
                    </span>
                    {session.agent.team && (
                      <span className="text-gray-600">{session.agent.team.name}</span>
                    )}
                    <span className="text-gray-600">|</span>
                    <span>
                      Attempt {attemptNumber} of {attempts.length}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-xs text-gray-500">
                    <span>{formatDuration(session.startedAt, session.completedAt)}</span>
                    <span>{formatCost(session.cost)}</span>
                    <span>{session.tokensUsed.toLocaleString()} tokens</span>
                    <span className="text-gray-600">{session.branch}</span>
                  </div>
                </div>
                <button
                  onClick={onClose}
                  className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-800 hover:text-gray-300"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                    <path d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z" />
                  </svg>
                </button>
              </div>

              {/* Attempts list */}
              {attempts.length > 1 && (
                <div className="mt-4 flex flex-wrap gap-2">
                  {attempts.map((attempt, i) => {
                    const isActive = attempt.id === activeSessionId;
                    const gatePassed = attempt.gateRuns.length > 0 && attempt.gateRuns[0].passed;
                    const gateFailed = attempt.gateRuns.length > 0 && !attempt.gateRuns[0].passed;
                    return (
                      <button
                        key={attempt.id}
                        onClick={() => setActiveSessionId(attempt.id)}
                        className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                          isActive
                            ? "border-blue-500 bg-blue-500/20 text-blue-300"
                            : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600 hover:text-gray-300"
                        }`}
                      >
                        <span className="font-medium">#{i + 1}</span>{" "}
                        <span
                          className={
                            attempt.status === "completed"
                              ? "text-green-400"
                              : attempt.status === "failed"
                                ? "text-red-400"
                                : attempt.status === "running"
                                  ? "text-blue-400"
                                  : "text-gray-500"
                          }
                        >
                          {attempt.status === "completed" ? (gatePassed ? "pass" : gateFailed ? "gate-fail" : "done") : attempt.status}
                        </span>{" "}
                        <span className="text-gray-600">{attempt.agent.name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Prompt Sent */}
            <div className="p-5">
              <details open={session.status === "failed"}>
                <summary className="cursor-pointer text-sm font-semibold text-gray-300 hover:text-gray-100">
                  Prompt Sent
                </summary>
                <div className="mt-3">
                  {session.prompt ? (
                    <pre className="max-h-96 overflow-auto rounded-lg bg-gray-800 p-4 text-xs text-gray-300 whitespace-pre-wrap font-mono">
                      {session.prompt}
                    </pre>
                  ) : (
                    <p className="text-sm text-gray-500 italic">
                      Prompt not recorded for this session
                    </p>
                  )}
                </div>
              </details>
            </div>

            {/* Quality Gate */}
            {session.gateRuns.length > 0 && (
              <div className="p-5">
                <details>
                  <summary className="cursor-pointer text-sm font-semibold text-gray-300 hover:text-gray-100">
                    Quality Gate ({session.gateRuns[0].passed ? "Passed" : "Failed"})
                  </summary>
                  <div className="mt-3 space-y-3">
                    {session.gateRuns.map((gate) => {
                      let checks: { name: string; passed: boolean; details: string }[] = [];
                      try {
                        checks = JSON.parse(gate.checks);
                      } catch {
                        // invalid JSON
                      }
                      return (
                        <div key={gate.id} className="rounded-lg bg-gray-800 p-4">
                          <div className="flex items-center gap-2 mb-2">
                            <span
                              className={`text-sm font-medium ${gate.passed ? "text-green-400" : "text-red-400"}`}
                            >
                              {gate.passed ? "PASSED" : "FAILED"}
                            </span>
                            <span className="text-xs text-gray-500">
                              {formatDate(gate.createdAt)}
                            </span>
                          </div>
                          {checks.length > 0 && (
                            <div className="space-y-1 mb-3">
                              {checks.map((check, i) => (
                                <div key={i} className="flex items-start gap-2 text-xs">
                                  <span className={check.passed ? "text-green-400" : "text-red-400"}>
                                    {check.passed ? "\u2713" : "\u2717"}
                                  </span>
                                  <span className="text-gray-300 font-medium">{check.name}:</span>
                                  <span className="text-gray-400">{check.details.slice(0, 200)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          <p className="text-xs text-gray-400 italic">{gate.reasoning}</p>
                        </div>
                      );
                    })}
                  </div>
                </details>
              </div>
            )}

            {/* Failure Triage */}
            {session.triageLogs.length > 0 && (
              <div className="p-5">
                <details open>
                  <summary className="cursor-pointer text-sm font-semibold text-gray-300 hover:text-gray-100">
                    Failure Triage ({session.triageLogs.length})
                  </summary>
                  <div className="mt-3 space-y-3">
                    {session.triageLogs.map((triage) => (
                      <div key={triage.id} className="rounded-lg bg-gray-800 p-4">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="rounded-full bg-red-500/20 px-2 py-0.5 text-xs font-medium text-red-400 border border-red-500/30">
                            {triage.category}
                          </span>
                          <span className="rounded-full bg-gray-700 px-2 py-0.5 text-xs text-gray-400">
                            {triage.resolution}
                          </span>
                          {triage.linkedBugKey && (
                            <span className="text-xs text-blue-400">{triage.linkedBugKey}</span>
                          )}
                        </div>
                        <p className="text-sm text-gray-300 mb-1">{triage.summary}</p>
                        {triage.rootCause && (
                          <p className="text-xs text-gray-400">
                            <span className="text-gray-500">Root cause:</span> {triage.rootCause}
                          </p>
                        )}
                        <p className="text-xs text-gray-400 mt-1">
                          <span className="text-gray-500">Suggested fix:</span> {triage.suggestedFix}
                        </p>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            )}

            {/* Agent Output */}
            <div className="p-5">
              <details>
                <summary className="cursor-pointer text-sm font-semibold text-gray-300 hover:text-gray-100">
                  Agent Output
                </summary>
                <div className="mt-3">
                  {outputText ? (
                    <>
                      <pre className="max-h-96 overflow-auto rounded-lg bg-gray-800 p-4 text-xs text-gray-300 whitespace-pre-wrap font-mono">
                        {displayOutput}
                      </pre>
                      {outputTruncated && !showFullOutput && (
                        <button
                          onClick={() => setShowFullOutput(true)}
                          className="mt-2 text-xs text-blue-400 hover:text-blue-300"
                        >
                          Show full output ({outputText.length.toLocaleString()} chars)
                        </button>
                      )}
                    </>
                  ) : (
                    <p className="text-sm text-gray-500 italic">No output recorded</p>
                  )}
                </div>
              </details>
            </div>

            {/* Retry Section */}
            <div className="p-5">
              <h3 className="text-sm font-semibold text-gray-300 mb-3">Retry with Modified Prompt</h3>
              <textarea
                value={retryPrompt}
                onChange={(e) => setRetryPrompt(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 p-3 text-xs text-gray-300 font-mono resize-y min-h-[120px] focus:border-blue-500 focus:outline-none"
                placeholder="Enter prompt for retry..."
              />
              {retryError && <p className="mt-2 text-xs text-red-400">{retryError}</p>}
              <div className="mt-3 flex justify-end">
                <button
                  onClick={handleRetry}
                  disabled={retrying || !retryPrompt.trim()}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {retrying ? "Retrying..." : "Retry with this prompt"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
