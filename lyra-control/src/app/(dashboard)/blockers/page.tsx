"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";

type AbandonedTicket = {
  ticketKey: string;
  projectId: string;
  failureCount: number;
  lastOutput: string;
  lastGateFailure: string;
};

type GateFailure = {
  id: string;
  ticketKey: string;
  projectId: string;
  checks: string;
  reasoning: string;
  createdAt: string;
};

type OpenPr = {
  projectId: string;
  repo: string;
  number: number;
  title: string;
  branch: string;
  url: string;
  createdAt: string;
};

export default function BlockersPage() {
  const [abandoned, setAbandoned] = useState<AbandonedTicket[]>([]);
  const [gateFailures, setGateFailures] = useState<GateFailure[]>([]);
  const [openPrs, setOpenPrs] = useState<OpenPr[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(api("/api/blockers"));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setAbandoned(data.abandonedTickets);
      setGateFailures(data.gateFailures);
      setOpenPrs(data.openPrs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleRetry = async (ticketKey: string, projectId: string) => {
    setActionLoading(`retry-${ticketKey}`);
    setError(null);
    try {
      const res = await fetch(api("/api/blockers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", ticketKey, projectId }),
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

  const handleMerge = async (repo: string, prNumber: number, projectId: string) => {
    setActionLoading(`merge-${prNumber}`);
    setError(null);
    try {
      const res = await fetch(api("/api/blockers"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "merge", repo, prNumber, projectId }),
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

  const totalBlockers = abandoned.length + gateFailures.length + openPrs.length;

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl space-y-6">
        <h1 className="text-2xl font-bold">Blockers</h1>
        <div className="text-gray-400 py-10 text-center">Loading blockers...</div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold">Blockers</h1>
          {totalBlockers > 0 && (
            <span className="rounded-full bg-red-900/30 px-2.5 py-0.5 text-sm font-medium text-red-400">
              {totalBlockers}
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

      {totalBlockers === 0 && (
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-8 text-center text-gray-400">
          No blockers found. All systems are running smoothly.
        </div>
      )}

      {/* Section 1: Abandoned Tickets */}
      {abandoned.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-red-400">Abandoned Tickets</h2>
          <p className="text-sm text-gray-500">Tickets that hit max retries with no successful completion.</p>
          <div className="space-y-2">
            {abandoned.map((t) => (
              <div key={t.ticketKey} className="rounded-lg border border-red-900/50 bg-gray-900 p-4 space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="font-mono text-sm font-medium text-gray-200">{t.ticketKey}</span>
                    <span className="rounded bg-red-900/30 px-1.5 py-0.5 text-xs text-red-400">
                      {t.failureCount} failures
                    </span>
                  </div>
                  <button
                    onClick={() => handleRetry(t.ticketKey, t.projectId)}
                    disabled={actionLoading === `retry-${t.ticketKey}`}
                    className="rounded-lg border border-yellow-700 px-3 py-1 text-sm text-yellow-400 hover:bg-yellow-900/20 disabled:opacity-50 cursor-pointer"
                  >
                    {actionLoading === `retry-${t.ticketKey}` ? "Retrying..." : "Reset & Retry"}
                  </button>
                </div>
                {t.lastGateFailure && (
                  <div className="text-sm text-gray-400">
                    <span className="text-gray-500">Last gate failure:</span> {t.lastGateFailure}
                  </div>
                )}
                {t.lastOutput && (
                  <div className="rounded bg-gray-800 p-2 text-xs text-gray-500 font-mono whitespace-pre-wrap">
                    {t.lastOutput}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Section 2: Recent Gate Failures */}
      {gateFailures.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-yellow-400">Recent Gate Failures</h2>
          <p className="text-sm text-gray-500">Quality gate failures with no subsequent passing gate.</p>
          <div className="space-y-2">
            {gateFailures.map((gf) => {
              let failedChecks: Array<{ name: string; passed: boolean; details: string }> = [];
              try {
                failedChecks = (JSON.parse(gf.checks) as Array<{ name: string; passed: boolean; details: string }>).filter((c) => !c.passed);
              } catch { /* invalid JSON */ }

              return (
                <div key={gf.id} className="rounded-lg border border-yellow-900/50 bg-gray-900 p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="font-mono text-sm font-medium text-gray-200">{gf.ticketKey}</span>
                      <span className="text-xs text-gray-500">
                        {new Date(gf.createdAt).toLocaleDateString()}
                      </span>
                    </div>
                    <button
                      onClick={() => handleRetry(gf.ticketKey, gf.projectId)}
                      disabled={actionLoading === `retry-${gf.ticketKey}`}
                      className="rounded-lg border border-yellow-700 px-3 py-1 text-sm text-yellow-400 hover:bg-yellow-900/20 disabled:opacity-50 cursor-pointer"
                    >
                      {actionLoading === `retry-${gf.ticketKey}` ? "Retrying..." : "Retry"}
                    </button>
                  </div>
                  <div className="text-sm text-gray-400">{gf.reasoning}</div>
                  {failedChecks.length > 0 && (
                    <div className="space-y-1">
                      {failedChecks.map((c, i) => (
                        <div key={i} className="text-xs text-red-400">
                          ✗ {c.name}: {c.details.slice(0, 200)}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Section 3: Open PRs Not Merged */}
      {openPrs.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-blue-400">Open PRs Not Merged</h2>
          <p className="text-sm text-gray-500">Pull requests waiting to be merged.</p>
          <div className="space-y-2">
            {openPrs.map((pr) => {
              const age = Math.ceil((Date.now() - new Date(pr.createdAt).getTime()) / (24 * 60 * 60 * 1000));
              return (
                <div key={`${pr.repo}-${pr.number}`} className="flex items-center justify-between rounded-lg border border-blue-900/50 bg-gray-900 p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-blue-400 hover:text-blue-300 truncate"
                      >
                        #{pr.number} {pr.title}
                      </a>
                      <span className="text-xs text-gray-500">{age}d old</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {pr.repo} / {pr.branch}
                    </div>
                  </div>
                  <button
                    onClick={() => handleMerge(pr.repo, pr.number, pr.projectId)}
                    disabled={actionLoading === `merge-${pr.number}`}
                    className="ml-3 rounded-lg border border-green-700 px-3 py-1 text-sm text-green-400 hover:bg-green-900/20 disabled:opacity-50 cursor-pointer"
                  >
                    {actionLoading === `merge-${pr.number}` ? "Merging..." : "Merge"}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
