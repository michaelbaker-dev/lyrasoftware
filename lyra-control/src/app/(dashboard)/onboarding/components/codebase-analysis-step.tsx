"use client";

import { useState, useEffect, useRef } from "react";
import {
  analyzeExistingCodebase,
  getCodebaseAnalysis,
  generateAnalysisSummary,
} from "../actions";
import ModelSelector from "@/components/model-selector";
import type { OnboardingData } from "../onboarding-wizard";
import type { CodebaseAnalysis } from "@/lib/codebase-analyzer";

type CodebaseAnalysisStepProps = {
  data: OnboardingData;
  onNext: () => void;
  onBack?: () => void;
};

type SummaryStats = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  tokensPerSecond: number;
  provider: string;
};

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default function CodebaseAnalysisStep({
  data,
  onNext,
  onBack,
}: CodebaseAnalysisStepProps) {
  const [fsStatus, setFsStatus] = useState<"idle" | "analyzing" | "complete" | "failed">("idle");
  const [aiStatus, setAiStatus] = useState<"idle" | "generating" | "complete" | "failed">("idle");
  const [analysis, setAnalysis] = useState<CodebaseAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [model, setModel] = useState("openrouter/auto");
  const [usedModel, setUsedModel] = useState("");
  const [summaryStats, setSummaryStats] = useState<SummaryStats | null>(null);
  const [aiElapsed, setAiElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  // Auto-trigger filesystem analysis on mount, or load existing
  useEffect(() => {
    let cancelled = false;

    async function loadOrAnalyze() {
      const existing = await getCodebaseAnalysis(data.jiraKey);
      if (existing && !cancelled) {
        setAnalysis(existing);
        setFsStatus("complete");
        if (existing.aiSummary) {
          setAiStatus("complete");
        }
        return;
      }
      if (!cancelled) {
        runFilesystemAnalysis();
      }
    }

    loadOrAnalyze();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Timer for AI generation
  useEffect(() => {
    if (aiStatus === "generating") {
      setAiElapsed(0);
      timerRef.current = setInterval(() => setAiElapsed((p) => p + 1), 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [aiStatus]);

  const runFilesystemAnalysis = async () => {
    setFsStatus("analyzing");
    setError(null);
    setLogs([]);

    const result = await analyzeExistingCodebase(data.jiraKey, data.localPath);
    setLogs(result.logs);

    if (result.success && result.analysis) {
      setAnalysis(result.analysis);
      setFsStatus("complete");
    } else {
      setError(result.error || "Filesystem analysis failed");
      setFsStatus("failed");
    }
  };

  const runAiSummary = async () => {
    setAiStatus("generating");
    setError(null);
    cancelledRef.current = false;

    const result = await generateAnalysisSummary({
      jiraKey: data.jiraKey,
      model,
    });

    if (cancelledRef.current) return;

    if (result.success && result.summary) {
      // Update local analysis with the new summary
      setAnalysis((prev) => prev ? { ...prev, aiSummary: result.summary! } : prev);
      setUsedModel(result.usedModel || "");
      setSummaryStats(result.stats || null);
      setAiStatus("complete");
      setLogs((prev) => [...prev, ...result.logs]);
    } else {
      setError(result.error || "AI summary generation failed");
      setAiStatus("failed");
      setLogs((prev) => [...prev, ...result.logs]);
    }
  };

  const handleCancelAi = () => {
    cancelledRef.current = true;
    setAiStatus(analysis?.aiSummary ? "complete" : "idle");
    setError("Generation cancelled.");
  };

  const isLocal = model.startsWith("local:");
  const busy = fsStatus === "analyzing" || aiStatus === "generating";

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">Codebase Analysis</h2>
        <p className="text-gray-400">
          Analyzing your existing codebase to inform PRD/ARD generation with real project data.
        </p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Filesystem analysis status */}
      {fsStatus === "analyzing" && (
        <div className="flex items-center gap-3 rounded-lg bg-blue-500/10 border border-blue-500/30 p-4">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-blue-400 border-t-transparent" />
          <span className="text-blue-300">Scanning filesystem...</span>
        </div>
      )}

      {fsStatus === "failed" && (
        <div className="rounded-lg bg-red-500/10 border border-red-500/30 p-4">
          <p className="text-red-300 text-sm">{error}</p>
          <button
            onClick={runFilesystemAnalysis}
            className="mt-2 px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded-lg transition-colors"
          >
            Retry Scan
          </button>
        </div>
      )}

      {/* Filesystem results */}
      {analysis && fsStatus === "complete" && (
        <div className="space-y-4">
          {/* Summary grid */}
          <div className="grid grid-cols-2 gap-4">
            <InfoCard label="Framework" value={analysis.framework} />
            <InfoCard label="Language" value={analysis.language} />
            <InfoCard label="Package Manager" value={analysis.packageManager} />
            <InfoCard label="Test Framework" value={analysis.testFramework || "None detected"} />
          </div>

          {/* Key dependencies */}
          {analysis.keyDependencies.length > 0 && (
            <div className="rounded-lg bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Key Dependencies</h3>
              <div className="flex flex-wrap gap-2">
                {analysis.keyDependencies.map((dep) => (
                  <span
                    key={dep}
                    className="px-2 py-0.5 bg-gray-700 text-gray-300 text-xs rounded-full"
                  >
                    {dep}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Scripts */}
          {Object.keys(analysis.scripts).length > 0 && (
            <div className="rounded-lg bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Scripts</h3>
              <div className="space-y-1">
                {Object.entries(analysis.scripts).slice(0, 10).map(([name, cmd]) => (
                  <div key={name} className="flex gap-2 text-xs">
                    <span className="text-blue-400 font-mono w-24 shrink-0">{name}</span>
                    <span className="text-gray-400 font-mono truncate">{cmd}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Directory overview */}
          {analysis.directoryOverview && (
            <details className="rounded-lg bg-gray-800 p-4">
              <summary className="text-sm font-semibold text-gray-300 cursor-pointer hover:text-gray-100">
                Directory Structure
              </summary>
              <pre className="mt-2 text-xs text-gray-400 font-mono whitespace-pre overflow-x-auto max-h-64 overflow-y-auto">
                {analysis.directoryOverview}
              </pre>
            </details>
          )}

          {/* Entry points */}
          {analysis.entryPoints.length > 0 && (
            <div className="rounded-lg bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Entry Points</h3>
              <div className="space-y-1">
                {analysis.entryPoints.map((ep) => (
                  <span key={ep} className="block text-xs text-gray-400 font-mono">{ep}</span>
                ))}
              </div>
            </div>
          )}

          {/* Code Statistics */}
          {analysis.codeStats && analysis.codeStats.totalFiles > 0 && (
            <div className="rounded-lg bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Code Statistics</h3>
              <div className="flex gap-6 mb-3">
                <div>
                  <span className="text-2xl font-bold text-blue-400">{analysis.codeStats.totalFiles}</span>
                  <span className="text-xs text-gray-500 ml-1">files</span>
                </div>
                <div>
                  <span className="text-2xl font-bold text-green-400">{analysis.codeStats.totalLines.toLocaleString()}</span>
                  <span className="text-xs text-gray-500 ml-1">lines</span>
                </div>
              </div>
              <div className="space-y-1">
                {Object.entries(analysis.codeStats.byExtension)
                  .sort(([, a], [, b]) => b.lines - a.lines)
                  .slice(0, 8)
                  .map(([ext, stats]) => (
                    <div key={ext} className="flex items-center gap-2 text-xs">
                      <span className="text-blue-400 font-mono w-12">{ext}</span>
                      <div className="flex-1 bg-gray-700 rounded-full h-2 overflow-hidden">
                        <div
                          className="bg-blue-500/60 h-full rounded-full"
                          style={{ width: `${Math.max(2, (stats.lines / analysis.codeStats.totalLines) * 100)}%` }}
                        />
                      </div>
                      <span className="text-gray-400 w-24 text-right">{stats.files}f / {stats.lines.toLocaleString()}L</span>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* API Routes */}
          {analysis.apiRoutes && analysis.apiRoutes.length > 0 && (
            <div className="rounded-lg bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">API Routes ({analysis.apiRoutes.length})</h3>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {analysis.apiRoutes.map((route) => (
                  <span key={route} className="block text-xs text-emerald-400 font-mono">{route}</span>
                ))}
              </div>
            </div>
          )}

          {/* Components / Pages */}
          {analysis.components && analysis.components.length > 0 && (
            <details className="rounded-lg bg-gray-800 p-4">
              <summary className="text-sm font-semibold text-gray-300 cursor-pointer hover:text-gray-100">
                Components / Pages ({analysis.components.length})
              </summary>
              <div className="mt-2 flex flex-wrap gap-2 max-h-48 overflow-y-auto">
                {analysis.components.map((comp) => (
                  <span
                    key={comp}
                    className="px-2 py-0.5 bg-gray-700 text-gray-300 text-xs rounded-full"
                  >
                    {comp}
                  </span>
                ))}
              </div>
            </details>
          )}

          {/* Database Models */}
          {analysis.dbModels && analysis.dbModels.length > 0 && (
            <div className="rounded-lg bg-gray-800 p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Database Models ({analysis.dbModels.length})</h3>
              <div className="flex flex-wrap gap-2">
                {analysis.dbModels.map((model) => (
                  <span
                    key={model}
                    className="px-2 py-0.5 bg-purple-900/30 text-purple-300 text-xs rounded-full border border-purple-800/50"
                  >
                    {model}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Architecture row */}
          <div className="grid grid-cols-2 gap-4">
            {analysis.stateManagement && <InfoCard label="State Management" value={analysis.stateManagement} />}
            {analysis.authPattern && <InfoCard label="Auth Pattern" value={analysis.authPattern} />}
            {analysis.monorepoType && <InfoCard label="Monorepo" value={analysis.monorepoType} />}
          </div>

          {/* Config Summary */}
          {analysis.configSummary && Object.keys(analysis.configSummary).length > 0 && (
            <details className="rounded-lg bg-gray-800 p-4">
              <summary className="text-sm font-semibold text-gray-300 cursor-pointer hover:text-gray-100">
                Config Summary ({Object.keys(analysis.configSummary).length} configs)
              </summary>
              <div className="mt-2 space-y-1">
                {Object.entries(analysis.configSummary).map(([key, value]) => (
                  <div key={key} className="flex gap-2 text-xs">
                    <span className="text-blue-400 font-mono w-28 shrink-0">{key}</span>
                    <span className="text-gray-400 font-mono">{value}</span>
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Environment Variables */}
          {analysis.envVars && analysis.envVars.length > 0 && (
            <details className="rounded-lg bg-gray-800 p-4">
              <summary className="text-sm font-semibold text-gray-300 cursor-pointer hover:text-gray-100">
                Environment Variables ({analysis.envVars.length})
              </summary>
              <div className="mt-2 flex flex-wrap gap-2">
                {analysis.envVars.map((v) => (
                  <span
                    key={v}
                    className="px-2 py-0.5 bg-yellow-900/20 text-yellow-400 text-xs rounded-full border border-yellow-800/40 font-mono"
                  >
                    {v}
                  </span>
                ))}
              </div>
            </details>
          )}

          {/* Documentation Files */}
          {analysis.docFiles && Object.keys(analysis.docFiles).length > 0 && (
            <details className="rounded-lg bg-gray-800 p-4">
              <summary className="text-sm font-semibold text-gray-300 cursor-pointer hover:text-gray-100">
                Documentation ({Object.keys(analysis.docFiles).length} files)
              </summary>
              <div className="mt-2 space-y-3">
                {Object.entries(analysis.docFiles).map(([path, content]) => (
                  <details key={path} className="rounded bg-gray-900 border border-gray-700">
                    <summary className="px-3 py-2 text-xs text-green-400 font-mono cursor-pointer hover:text-green-300">
                      {path}
                    </summary>
                    <pre className="px-3 pb-3 text-xs text-gray-400 font-mono whitespace-pre-wrap overflow-x-auto max-h-64 overflow-y-auto">
                      {content}
                    </pre>
                  </details>
                ))}
              </div>
            </details>
          )}

          {/* Source Excerpts */}
          {analysis.sourceExcerpts && Object.keys(analysis.sourceExcerpts).length > 0 && (
            <details className="rounded-lg bg-gray-800 p-4">
              <summary className="text-sm font-semibold text-gray-300 cursor-pointer hover:text-gray-100">
                Source Excerpts ({Object.keys(analysis.sourceExcerpts).length} key files)
              </summary>
              <div className="mt-2 space-y-3">
                {Object.entries(analysis.sourceExcerpts).map(([path, content]) => (
                  <details key={path} className="rounded bg-gray-900 border border-gray-700">
                    <summary className="px-3 py-2 text-xs text-blue-400 font-mono cursor-pointer hover:text-blue-300">
                      {path}
                    </summary>
                    <pre className="px-3 pb-3 text-xs text-gray-400 font-mono whitespace-pre overflow-x-auto max-h-64 overflow-y-auto">
                      {content}
                    </pre>
                  </details>
                ))}
              </div>
            </details>
          )}

          {/* Additional info */}
          <div className="grid grid-cols-2 gap-4">
            {analysis.ciConfig && <InfoCard label="CI Workflows" value={analysis.ciConfig} />}
            {analysis.buildOutput && <InfoCard label="Build Output" value={analysis.buildOutput} />}
            {analysis.testPattern && <InfoCard label="Test Pattern" value={analysis.testPattern} />}
          </div>

          {/* Existing AI config notice */}
          {analysis.existingAiConfig && (
            <div className="rounded-lg bg-yellow-500/10 border border-yellow-500/30 p-4">
              <p className="text-yellow-300 text-sm">
                Existing AI config (CLAUDE.md or .cursorrules) detected. It will be preserved and enhanced during scaffolding.
              </p>
            </div>
          )}

          {/* Re-scan button */}
          <button
            onClick={runFilesystemAnalysis}
            disabled={busy}
            className="text-sm text-gray-400 hover:text-gray-200 underline disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Re-scan filesystem
          </button>

          {/* ── AI Summary Section ──────────────────────────────────── */}
          <div className="rounded-lg border border-purple-800/50 bg-purple-900/10 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-purple-200">AI Architectural Summary</h3>
                <p className="text-xs text-gray-500 mt-0.5">
                  An LLM analyzes the filesystem scan above to produce an architectural assessment
                </p>
              </div>
              {aiStatus === "complete" && (
                <span className="px-2 py-1 rounded text-xs font-medium bg-green-900/30 text-green-400 border border-green-800/50">
                  Generated
                </span>
              )}
            </div>

            {/* Model selector — shown when idle or complete (for regeneration) */}
            {(aiStatus === "idle" || aiStatus === "complete" || aiStatus === "failed") && (
              <ModelSelector value={model} onChange={setModel} persistKey="codebase_analysis" />
            )}

            {/* Generate / Regenerate button */}
            {(aiStatus === "idle" || aiStatus === "failed") && (
              <div className="flex justify-center">
                <button
                  onClick={runAiSummary}
                  className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors cursor-pointer"
                >
                  Generate AI Summary
                </button>
              </div>
            )}

            {/* Generating spinner */}
            {aiStatus === "generating" && (
              <div className="flex flex-col items-center gap-3 py-6">
                <div className="h-10 w-10 animate-spin rounded-full border-3 border-gray-600 border-t-purple-500" />
                <p className="text-gray-300 font-medium">Generating architectural summary...</p>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-mono text-purple-400">{formatElapsed(aiElapsed)}</span>
                  <span className="text-gray-500">elapsed</span>
                </div>
                <p className="text-sm text-gray-500 text-center max-w-md">
                  {isLocal
                    ? aiElapsed < 30
                      ? "Local model is generating..."
                      : "Large local models can take a while — this is normal..."
                    : aiElapsed < 15
                      ? "Model is generating..."
                      : "Still generating — this is normal..."}
                </p>
                <div className="w-64 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full animate-pulse"
                    style={{
                      width: `${Math.min(95, (aiElapsed / (isLocal ? 300 : 120)) * 100)}%`,
                      transition: "width 1s linear",
                    }}
                  />
                </div>
                <button
                  onClick={handleCancelAi}
                  className="mt-1 px-4 py-1.5 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            )}

            {/* AI Summary result */}
            {aiStatus === "complete" && analysis?.aiSummary && (
              <div className="space-y-3">
                {usedModel && (
                  <div className="text-xs text-gray-500">
                    Generated by <span className="font-mono text-gray-400">{usedModel}</span>
                    {isLocal ? (
                      <span className="ml-1 text-emerald-600">(local)</span>
                    ) : (
                      <span className="ml-1 text-purple-600">(cloud)</span>
                    )}
                  </div>
                )}

                {summaryStats && (
                  <div className="flex flex-wrap gap-3 text-xs">
                    <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                      {summaryStats.promptTokens.toLocaleString()} in / {summaryStats.completionTokens.toLocaleString()} out tokens
                    </span>
                    <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                      {summaryStats.tokensPerSecond} tok/s
                    </span>
                    <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                      {formatDuration(summaryStats.durationMs)}
                    </span>
                    {summaryStats.cost > 0 ? (
                      <span className="px-2 py-1 rounded bg-purple-900/30 border border-purple-800/50 text-purple-400">
                        ${summaryStats.cost.toFixed(4)}
                      </span>
                    ) : (
                      <span className="px-2 py-1 rounded bg-emerald-900/30 border border-emerald-800/50 text-emerald-400">
                        Free
                      </span>
                    )}
                  </div>
                )}

                <div className="rounded-lg bg-gray-900 border border-gray-700 p-4 text-sm text-gray-300 whitespace-pre-wrap max-h-96 overflow-y-auto font-mono leading-relaxed">
                  {analysis.aiSummary}
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={runAiSummary}
                    className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors cursor-pointer"
                  >
                    Regenerate
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <details className="text-xs text-gray-500">
          <summary className="cursor-pointer hover:text-gray-300">Analysis log</summary>
          <div className="mt-1 space-y-0.5 font-mono">
            {logs.map((log, i) => (
              <div key={i}>{log}</div>
            ))}
          </div>
        </details>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        {onBack && (
          <button
            onClick={onBack}
            disabled={busy}
            className="px-6 py-2 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            Back
          </button>
        )}
        <button
          onClick={onNext}
          disabled={busy}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors ml-auto"
        >
          {fsStatus === "complete" ? "Next" : fsStatus === "failed" ? "Skip & Continue" : fsStatus === "analyzing" ? "Analyzing..." : "Analyze"}
        </button>
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-gray-800 p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm text-gray-200 font-medium mt-0.5">{value}</div>
    </div>
  );
}
