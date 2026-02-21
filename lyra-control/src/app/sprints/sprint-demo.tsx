"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useSSELog } from "@/lib/use-sse-log";

type Ticket = {
  key: string;
  summary: string;
  status: "completed" | "failed";
  gatePassed: boolean | null;
  gateReasoning: string;
  prUrl: string | null;
  prState: string | null;
  agent: string;
  cost: number;
};

type DemoData = {
  tickets: Ticket[];
  project: { path: string; repo: string | null; runCmd: string; name: string };
  totals: { completed: number; failed: number; cost: number; gatePassRate: number };
  openPrCount: number;
  appStatus?: { running: boolean; ports: number[]; startedAt: string | null; outputTail: string[] };
};

type SprintDemoProps = {
  data: DemoData;
  projectId: string;
  sprintId: string;
  onClose: () => void;
};

type AppOutputEvent = { projectId: string; line: string };
type TriageResult = {
  category: string;
  action: string;
  summary: string;
  suggestedFix: string;
  linkedBugKey?: string;
};

type LaunchProgressEvent = {
  projectId: string;
  step: "analyzing" | "generating" | "validating" | "fixing" | "triaging" | "success" | "failed";
  attempt?: number;
  maxRetries?: number;
  error?: string;
  triageInfo?: {
    category: string;
    summary: string;
    suggestedFix: string;
    linkedBugKey?: string;
  };
};

export default function SprintDemo({ data, projectId, sprintId, onClose }: SprintDemoProps) {
  const [merging, setMerging] = useState(false);
  const [mergeResult, setMergeResult] = useState<{ results: Array<{ pr: number; merged: boolean; error?: string }> } | null>(null);
  const [copied, setCopied] = useState(false);

  // App control state
  const [appRunning, setAppRunning] = useState(data.appStatus?.running ?? false);
  const [appPorts, setAppPorts] = useState<number[]>(data.appStatus?.ports ?? []);
  const [launching, setLaunching] = useState(false);
  const [generatingScript, setGeneratingScript] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

  // Launch generation state
  const [maxRetries, setMaxRetries] = useState(3);
  const [launchProgress, setLaunchProgress] = useState<LaunchProgressEvent | null>(null);
  const [launchErrors, setLaunchErrors] = useState<string[]>([]);
  const [showLaunchErrors, setShowLaunchErrors] = useState(false);
  const [validationResult, setValidationResult] = useState<{ validated: boolean; attempts: number } | null>(null);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);

  // Release notes state
  const [releaseNotes, setReleaseNotes] = useState<{ markdown: string; filePath: string } | null>(null);
  const [generatingNotes, setGeneratingNotes] = useState(false);

  // SSE log for app output — filter to this project
  const outputFilter = useCallback(
    (d: AppOutputEvent) => d.projectId === projectId,
    [projectId]
  );
  const { lines: outputLines, clear: clearOutput } = useSSELog<AppOutputEvent>(
    "app:output",
    outputFilter
  );

  // SSE listener for launch progress
  const launchProgressFilter = useCallback(
    (d: LaunchProgressEvent) => d.projectId === projectId,
    [projectId]
  );
  const { lines: progressEvents } = useSSELog<LaunchProgressEvent>(
    "launch:progress",
    launchProgressFilter
  );
  const latestProgressRef = useRef<LaunchProgressEvent | null>(null);

  useEffect(() => {
    const latest = progressEvents[progressEvents.length - 1];
    if (latest && latest !== latestProgressRef.current) {
      latestProgressRef.current = latest;
      setLaunchProgress(latest);
      if (latest.error) {
        setLaunchErrors((prev) => [...prev, `[Attempt ${latest.attempt}/${latest.maxRetries}] ${latest.error}`]);
      }
    }
  }, [progressEvents]);

  // Combine initial output tail with streamed lines
  const allOutput = useMemo(() => {
    const initial = (data.appStatus?.outputTail ?? []).map((line) => ({
      projectId,
      line,
    }));
    return [...initial, ...outputLines];
  }, [data.appStatus?.outputTail, outputLines, projectId]);

  const callAction = async (action: string, extra?: Record<string, unknown>) => {
    const res = await fetch("/api/sprints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, projectId, ...extra }),
    });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    return result;
  };

  const handleMergeAll = async () => {
    setMerging(true);
    try {
      const result = await callAction("merge-all");
      setMergeResult(result);
    } catch (e) {
      setMergeResult({ results: [{ pr: 0, merged: false, error: (e as Error).message }] });
    } finally {
      setMerging(false);
    }
  };

  const [scriptError, setScriptError] = useState<string | null>(null);
  const [scriptPath, setScriptPath] = useState<string | null>(null);

  const handleGenerateScript = async () => {
    setGeneratingScript(true);
    setScriptError(null);
    setScriptPath(null);
    setLaunchProgress(null);
    setLaunchErrors([]);
    setValidationResult(null);
    setTriageResult(null);
    try {
      const result = await callAction("generate-launch", { maxRetries });
      setScriptPath(result.scriptPath);
      setValidationResult({ validated: result.validated, attempts: result.attempts });
      if (result.triaged && result.triageResult) {
        setTriageResult(result.triageResult);
      } else if (!result.validated && result.lastError) {
        setScriptError(`Validation failed after ${result.attempts} attempts: ${result.lastError}`);
      }
    } catch (e) {
      setScriptError((e as Error).message);
    } finally {
      setGeneratingScript(false);
      setLaunchProgress(null);
    }
  };

  const handleLaunch = async () => {
    setLaunching(true);
    clearOutput();
    try {
      const result = await callAction("launch");
      setAppRunning(true);
      setAppPorts(result.ports || []);
      setShowOutput(true);
    } catch (e) {
      console.error("Launch failed:", e);
    } finally {
      setLaunching(false);
    }
  };

  const handleStop = async () => {
    try {
      await callAction("stop");
      setAppRunning(false);
      setAppPorts([]);
    } catch (e) {
      console.error("Stop failed:", e);
    }
  };

  const handleGenerateReleaseNotes = async () => {
    setGeneratingNotes(true);
    try {
      const result = await callAction("release-notes", { sprintId });
      setReleaseNotes(result);
    } catch (e) {
      console.error("Release notes failed:", e);
    } finally {
      setGeneratingNotes(false);
    }
  };

  const launchProgressText = useMemo(() => {
    if (!launchProgress) return "Analyzing & Generating...";
    switch (launchProgress.step) {
      case "analyzing": return "Analyzing codebase...";
      case "generating": return "Generating launch config...";
      case "validating": return `Validating (${launchProgress.attempt}/${launchProgress.maxRetries})...`;
      case "fixing": return `Fixing errors (${launchProgress.attempt}/${launchProgress.maxRetries})...`;
      case "triaging": return "Error requires project fix \u2014 creating bug ticket...";
      case "success": return "Validated!";
      case "failed": return "Validation failed";
      default: return "Processing...";
    }
  }, [launchProgress]);

  const copyRunCmd = () => {
    navigator.clipboard.writeText(`cd ${data.project.path} && ${data.project.runCmd}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-4 rounded-lg border border-purple-800/50 bg-gray-900/80 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-purple-300">Sprint Demo</h3>
        <button
          onClick={onClose}
          className="text-gray-400 hover:text-gray-200 text-sm cursor-pointer"
        >
          Close
        </button>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 text-center">
          <div className="text-2xl font-bold text-green-400">{data.totals.completed}</div>
          <div className="text-xs text-gray-400">Completed</div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 text-center">
          <div className="text-2xl font-bold text-red-400">{data.totals.failed}</div>
          <div className="text-xs text-gray-400">Failed</div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 text-center">
          <div className="text-2xl font-bold text-blue-400">{data.totals.gatePassRate}%</div>
          <div className="text-xs text-gray-400">Gate Pass Rate</div>
        </div>
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-3 text-center">
          <div className="text-2xl font-bold text-yellow-400">${data.totals.cost.toFixed(2)}</div>
          <div className="text-xs text-gray-400">Total Cost</div>
        </div>
      </div>

      {/* How to Run */}
      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-3">
        <div className="text-xs font-medium text-gray-400 mb-1">How to Run</div>
        <div className="flex items-center gap-2">
          <code className="flex-1 text-sm text-green-300 bg-gray-900 rounded px-2 py-1">
            cd {data.project.path} && {data.project.runCmd}
          </code>
          <button
            onClick={copyRunCmd}
            className="rounded border border-gray-600 px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-gray-700 cursor-pointer"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      {/* App Control Bar */}
      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-3">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Status indicator */}
          <div className="flex items-center gap-1.5">
            <div className={`h-2.5 w-2.5 rounded-full ${appRunning ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            <span className={`text-sm font-medium ${appRunning ? "text-green-400" : "text-gray-400"}`}>
              {appRunning ? "Running" : "Stopped"}
            </span>
            {appPorts.length > 0 && (
              <span className="text-xs text-gray-500">
                ({appPorts.map((p) => `:${p}`).join(", ")})
              </span>
            )}
          </div>

          <div className="flex-1" />

          {/* Action buttons */}
          <div className="flex items-center gap-1.5">
            <label className="text-xs text-gray-500" title="Max self-healing retries">
              Retries:
            </label>
            <input
              type="number"
              min={1}
              max={10}
              value={maxRetries}
              onChange={(e) => setMaxRetries(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
              disabled={generatingScript}
              className="w-12 rounded border border-gray-600 bg-gray-800 px-1.5 py-1 text-xs text-gray-300 text-center disabled:opacity-50"
            />
          </div>
          <button
            onClick={handleGenerateScript}
            disabled={generatingScript}
            className="rounded border border-gray-600 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-50 cursor-pointer"
          >
            {generatingScript ? launchProgressText : "Generate Launch Script"}
          </button>
          {scriptPath && (
            <span className="text-xs text-green-400">
              {scriptPath}
              {validationResult && (
                <span className={validationResult.validated ? "text-green-400" : "text-yellow-400"}>
                  {" "}({validationResult.validated ? "validated" : "unvalidated"}, {validationResult.attempts} attempt{validationResult.attempts !== 1 ? "s" : ""})
                </span>
              )}
            </span>
          )}
          {scriptError && (
            <span className="text-xs text-red-400">{scriptError}</span>
          )}

          {!appRunning ? (
            <button
              onClick={handleLaunch}
              disabled={launching}
              className="rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-500 disabled:opacity-50 cursor-pointer"
            >
              {launching ? "Launching..." : "Launch App"}
            </button>
          ) : (
            <button
              onClick={handleStop}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-500 cursor-pointer"
            >
              Stop
            </button>
          )}

          {allOutput.length > 0 && (
            <button
              onClick={() => setShowOutput((v) => !v)}
              className="rounded border border-gray-600 px-2 py-1.5 text-xs text-gray-400 hover:text-white cursor-pointer"
            >
              {showOutput ? "Hide Output" : "Show Output"}
            </button>
          )}
        </div>

        {/* Output log */}
        {showOutput && allOutput.length > 0 && (
          <pre className="mt-3 max-h-60 overflow-y-auto rounded bg-gray-950 p-2 text-xs text-gray-300 font-mono">
            {allOutput.map((o, i) => (
              <div key={i}>{o.line}</div>
            ))}
          </pre>
        )}

        {/* Triage result banner */}
        {triageResult && (
          <div className="mt-3 rounded-lg border border-yellow-700/50 bg-yellow-900/20 p-3 space-y-1">
            <div className="text-sm font-medium text-yellow-300">Project Fix Required</div>
            <div className="text-xs text-yellow-200/80">
              <span className="font-medium">Category:</span> {triageResult.category}
            </div>
            <div className="text-xs text-yellow-200/80">
              <span className="font-medium">Issue:</span> {triageResult.summary}
            </div>
            <div className="text-xs text-yellow-200/80">
              <span className="font-medium">Suggested Fix:</span> {triageResult.suggestedFix}
            </div>
            {triageResult.linkedBugKey && (
              <div className="text-xs text-yellow-200/80">
                <span className="font-medium">Bug Ticket:</span>{" "}
                <span className="font-mono text-yellow-300">{triageResult.linkedBugKey}</span>
              </div>
            )}
          </div>
        )}

        {/* Launch validation errors */}
        {launchErrors.length > 0 && (
          <div className="mt-3">
            <button
              onClick={() => setShowLaunchErrors((v) => !v)}
              className="text-xs text-yellow-400 hover:text-yellow-300 cursor-pointer"
            >
              {showLaunchErrors ? "Hide" : "Show"} validation errors ({launchErrors.length})
            </button>
            {showLaunchErrors && (
              <pre className="mt-1 max-h-40 overflow-y-auto rounded bg-gray-950 p-2 text-xs text-red-300 font-mono whitespace-pre-wrap">
                {launchErrors.join("\n\n")}
              </pre>
            )}
          </div>
        )}
      </div>

      {/* Ticket Outcomes Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700 text-left text-xs text-gray-400">
              <th className="pb-2 pr-3">Key</th>
              <th className="pb-2 pr-3">Status</th>
              <th className="pb-2 pr-3">Gate</th>
              <th className="pb-2 pr-3">PR</th>
              <th className="pb-2 pr-3">Agent</th>
              <th className="pb-2 text-right">Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.tickets.map((t) => (
              <tr key={t.key} className="border-b border-gray-800">
                <td className="py-2 pr-3 font-mono text-gray-200">{t.key}</td>
                <td className="py-2 pr-3">
                  <span className={`rounded px-1.5 py-0.5 text-xs ${
                    t.status === "completed"
                      ? "bg-green-900/30 text-green-400"
                      : "bg-red-900/30 text-red-400"
                  }`}>
                    {t.status}
                  </span>
                </td>
                <td className="py-2 pr-3">
                  {t.gatePassed === null ? (
                    <span className="text-gray-500">&mdash;</span>
                  ) : (
                    <span
                      className={`cursor-help ${t.gatePassed ? "text-green-400" : "text-red-400"}`}
                      title={t.gateReasoning}
                    >
                      {t.gatePassed ? "\u2713" : "\u2717"}
                    </span>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {t.prUrl ? (
                    <a
                      href={t.prUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300"
                    >
                      PR
                      <span className={`rounded px-1 py-0.5 text-[10px] ${
                        t.prState === "MERGED"
                          ? "bg-purple-900/30 text-purple-400"
                          : "bg-green-900/30 text-green-400"
                      }`}>
                        {t.prState?.toLowerCase() ?? "open"}
                      </span>
                    </a>
                  ) : (
                    <span className="text-gray-500">&mdash;</span>
                  )}
                </td>
                <td className="py-2 pr-3 text-gray-400">{t.agent}</td>
                <td className="py-2 text-right text-gray-400">${t.cost.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Merge All Button */}
      {data.openPrCount > 0 && !mergeResult && (
        <button
          onClick={handleMergeAll}
          disabled={merging}
          className="rounded-lg bg-purple-600 px-4 py-2 text-sm font-medium text-white hover:bg-purple-500 disabled:opacity-50 transition-colors cursor-pointer"
        >
          {merging ? "Merging..." : `Merge All ${data.openPrCount} Open PRs`}
        </button>
      )}

      {/* Merge Results */}
      {mergeResult && (
        <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-3 text-sm space-y-1">
          <div className="font-medium text-gray-300">Merge Results</div>
          {mergeResult.results.map((r, i) => (
            <div key={i} className={r.merged ? "text-green-400" : "text-red-400"}>
              {r.pr > 0 ? `PR #${r.pr}: ` : ""}
              {r.merged ? "Merged" : `Failed \u2014 ${r.error}`}
            </div>
          ))}
        </div>
      )}

      {/* Release Notes */}
      <div className="rounded-lg border border-gray-700 bg-gray-800/30 p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="text-xs font-medium text-gray-400">Release Notes</div>
          <button
            onClick={handleGenerateReleaseNotes}
            disabled={generatingNotes}
            className="rounded border border-gray-600 px-3 py-1.5 text-xs text-gray-300 hover:text-white hover:bg-gray-700 disabled:opacity-50 cursor-pointer"
          >
            {generatingNotes ? "Generating..." : "Generate Release Notes"}
          </button>
        </div>
        {releaseNotes && (
          <div className="space-y-2">
            <div className="text-xs text-gray-500">
              Saved to: <code className="text-gray-400">{releaseNotes.filePath}</code>
            </div>
            <pre className="max-h-80 overflow-y-auto rounded bg-gray-950 p-3 text-xs text-gray-300 font-mono whitespace-pre-wrap">
              {releaseNotes.markdown}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
