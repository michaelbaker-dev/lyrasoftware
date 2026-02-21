"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  generatePrd,
  generateArd,
  approvePrd,
  approveArd,
  savePrdContent,
  saveArdContent,
  checkTavilyConfigured,
} from "../actions";
import type { SearchStats } from "../actions";
import ModelSelector from "@/components/model-selector";
import type { OnboardingData } from "../onboarding-wizard";

type ArchitectStepProps = {
  data: OnboardingData;
  onChange?: (data: OnboardingData) => void;
  onNext: () => void;
  onBack?: () => void;
  initialPrd?: string;
  initialArd?: string;
  initialPhase?: string;
  initialTechStack?: string;
  onCostAdd?: (cost: number) => void;
};

type DocPhase = "idle" | "generating" | "review" | "approved";

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ── Generating Spinner ──────────────────────────────────────────────

function GeneratingSpinner({
  label,
  isLocal,
  onCancel,
}: {
  label: string;
  isLocal: boolean;
  onCancel: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setElapsed(0);
    timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  const hint = isLocal
    ? elapsed < 5
      ? "Sending request to LM Studio..."
      : elapsed < 30
      ? "Local model is generating — speed depends on model size..."
      : elapsed < 120
      ? "Large local models can take a while — this is normal..."
      : "This is taking very long. The model may be too large for this task."
    : elapsed < 5
      ? "Sending request to OpenRouter..."
      : elapsed < 15
      ? "Model is generating..."
      : elapsed < 30
      ? "Still generating — this is normal..."
      : elapsed < 60
      ? "Taking a while — complex documents need more time..."
      : "This is taking unusually long. You can cancel and try a different model.";

  return (
    <div className="flex flex-col items-center gap-3 py-6">
      <div className="h-10 w-10 animate-spin rounded-full border-3 border-gray-600 border-t-purple-500" />
      <p className="text-gray-300 font-medium">{label}</p>
      <div className="flex items-center gap-2 text-sm">
        <span className="font-mono text-purple-400">{formatElapsed(elapsed)}</span>
        <span className="text-gray-500">elapsed</span>
      </div>
      <p className="text-sm text-gray-500 text-center max-w-md">{hint}</p>
      <div className="w-64 h-1.5 bg-gray-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full animate-pulse"
          style={{ width: `${Math.min(95, (elapsed / (isLocal ? 300 : 120)) * 100)}%`, transition: "width 1s linear" }}
        />
      </div>
      <button
        onClick={onCancel}
        className="mt-1 px-4 py-1.5 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors cursor-pointer"
      >
        Cancel
      </button>
    </div>
  );
}

// ── Document Editor Panel ───────────────────────────────────────────

type DocStats = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  durationMs: number;
  tokensPerSecond: number;
  provider: string;
  searchStats?: SearchStats;
};

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function DocPanel({
  title,
  phase,
  content,
  model,
  usedModel,
  feedback,
  stats,
  onGenerate,
  onRegenerate,
  onApprove,
  onStartOver,
  onContentChange,
  onFeedbackChange,
  onModelChange,
  onCancel,
  disabled,
}: {
  title: string;
  phase: DocPhase;
  content: string;
  model: string;
  usedModel: string;
  feedback: string;
  stats: DocStats | null;
  onGenerate: () => void;
  onRegenerate: () => void;
  onApprove: () => void;
  onStartOver: () => void;
  onContentChange: (c: string) => void;
  onFeedbackChange: (f: string) => void;
  onModelChange: (m: string) => void;
  onCancel: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-gray-100">{title}</h3>
        {phase === "approved" && (
          <span className="px-2 py-1 rounded text-xs font-medium bg-green-900/30 text-green-400 border border-green-800/50">
            Approved
          </span>
        )}
        {phase === "review" && (
          <span className="px-2 py-1 rounded text-xs font-medium bg-blue-900/30 text-blue-400 border border-blue-800/50">
            In Review
          </span>
        )}
      </div>

      {/* Idle — pick model and generate */}
      {phase === "idle" && (
        <div className="space-y-4">
          {disabled ? (
            <p className="text-sm text-gray-500">Complete and approve the PRD first.</p>
          ) : (
            <>
              <ModelSelector value={model} onChange={onModelChange} persistKey={title === "PRD" ? "prd" : "ard"} />
              <div className="flex justify-center">
                <button
                  onClick={onGenerate}
                  className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white font-medium rounded-lg transition-colors cursor-pointer"
                >
                  Generate {title}
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Generating */}
      {phase === "generating" && (
        <GeneratingSpinner
          label={`Generating ${title}...`}
          isLocal={model.startsWith("local:")}
          onCancel={onCancel}
        />
      )}

      {/* Review or Approved */}
      {(phase === "review" || phase === "approved") && (
        <div className="space-y-3">
          {usedModel && (
            <div className="text-xs text-gray-500">
              Generated by <span className="font-mono text-gray-400">{usedModel}</span>
              {model.startsWith("local:") ? (
                <span className="ml-1 text-emerald-600">(local)</span>
              ) : (
                <span className="ml-1 text-purple-600">(cloud)</span>
              )}
            </div>
          )}

          {stats && (
            <div className="space-y-2 text-xs">
              {stats.searchStats && (
                <div className="flex flex-wrap gap-3">
                  <span className="px-2 py-1 rounded bg-blue-900/20 border border-blue-800/40 text-blue-400">
                    Search: ${stats.searchStats.cost.toFixed(2)}
                  </span>
                  <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                    {stats.searchStats.provider === "openrouter" ? "OpenRouter :online" : "Tavily"}
                  </span>
                  <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                    {stats.searchStats.resultCount} results
                  </span>
                  {stats.searchStats.durationMs > 0 && (
                    <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                      {formatDuration(stats.searchStats.durationMs)}
                    </span>
                  )}
                </div>
              )}
              <div className="flex flex-wrap gap-3">
                {stats.searchStats && (
                  <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-500 font-medium">
                    LLM
                  </span>
                )}
                <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                  {stats.promptTokens.toLocaleString()} in / {stats.completionTokens.toLocaleString()} out
                </span>
                <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                  {stats.tokensPerSecond} tok/s
                </span>
                <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                  {formatDuration(stats.durationMs)}
                </span>
                {stats.cost > 0 ? (
                  <span className="px-2 py-1 rounded bg-purple-900/30 border border-purple-800/50 text-purple-400">
                    ${stats.cost.toFixed(4)}
                  </span>
                ) : (
                  <span className="px-2 py-1 rounded bg-emerald-900/30 border border-emerald-800/50 text-emerald-400">
                    Free
                  </span>
                )}
              </div>
            </div>
          )}

          <textarea
            value={content}
            onChange={(e) => onContentChange(e.target.value)}
            rows={16}
            disabled={phase === "approved"}
            className="w-full px-3 py-2 bg-gray-900 border border-gray-600 rounded-lg text-sm text-gray-300 font-mono focus:outline-none focus:ring-2 focus:ring-purple-600 focus:border-transparent resize-y disabled:opacity-60 disabled:cursor-not-allowed"
          />

          {phase === "review" && (
            <>
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-400">
                  Feedback for regeneration (optional)
                </label>
                <div className="flex items-center gap-3 mb-1">
                  <span className="text-xs text-gray-500">Regenerate with:</span>
                  <ModelSelector value={model} onChange={onModelChange} compact persistKey={title === "PRD" ? "prd" : "ard"} />
                </div>
                <textarea
                  value={feedback}
                  onChange={(e) => onFeedbackChange(e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 resize-none"
                  placeholder="e.g. Add more detail to functional requirements, change the database to PostgreSQL..."
                />
              </div>

              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={onStartOver}
                  className="px-4 py-2 text-sm text-red-400 hover:text-red-300 border border-red-800/50 hover:border-red-700 rounded-lg transition-colors cursor-pointer"
                >
                  Start Over
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={onRegenerate}
                    className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors cursor-pointer"
                  >
                    Regenerate
                  </button>
                  <button
                    onClick={onApprove}
                    className="px-5 py-2 text-sm bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors cursor-pointer"
                  >
                    Approve
                  </button>
                </div>
              </div>
            </>
          )}

          {phase === "approved" && (
            <div className="flex justify-end">
              <button
                onClick={onStartOver}
                className="px-4 py-2 text-sm text-gray-400 hover:text-gray-300 border border-gray-700 hover:border-gray-600 rounded-lg transition-colors cursor-pointer"
              >
                Revise
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Architect Step ─────────────────────────────────────────────

export default function ArchitectStep({
  data,
  onChange,
  onNext,
  onBack,
  initialPrd,
  initialArd,
  initialPhase,
  initialTechStack,
  onCostAdd,
}: ArchitectStepProps) {
  const getInitialPrdPhase = (): DocPhase => {
    if (initialPhase === "approved") return "approved";
    if (initialPrd) return "review";
    return "idle";
  };
  const getInitialArdPhase = (): DocPhase => {
    if (initialPhase === "approved") return "approved";
    if (initialArd) return "review";
    return "idle";
  };

  const [prdPhase, setPrdPhase] = useState<DocPhase>(getInitialPrdPhase());
  const [ardPhase, setArdPhase] = useState<DocPhase>(getInitialArdPhase());

  const [prdContent, setPrdContent] = useState(initialPrd || "");
  const [ardContent, setArdContent] = useState(initialArd || "");
  const [techStack, setTechStack] = useState(initialTechStack || "");

  const [prdModel, setPrdModel] = useState("openrouter/auto");
  const [ardModel, setArdModel] = useState("openrouter/auto");

  const [prdUsedModel, setPrdUsedModel] = useState("");
  const [ardUsedModel, setArdUsedModel] = useState("");

  const [prdStats, setPrdStats] = useState<DocStats | null>(null);
  const [ardStats, setArdStats] = useState<DocStats | null>(null);

  const [prdFeedback, setPrdFeedback] = useState("");
  const [ardFeedback, setArdFeedback] = useState("");

  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const [useWebSearch, setUseWebSearch] = useState(false);
  const [tavilyReady, setTavilyReady] = useState(false);

  useEffect(() => {
    checkTavilyConfigured().then(setTavilyReady).catch(() => setTavilyReady(false));
  }, []);

  const bothApproved = prdPhase === "approved" && ardPhase === "approved";

  // ── PRD actions ───────────────────────────────────────────────────

  const handleGeneratePrd = useCallback(async (previous?: string, feedback?: string) => {
    setPrdPhase("generating");
    setError(null);
    cancelledRef.current = false;

    try {
      const result = await generatePrd({
        projectName: data.projectName,
        jiraKey: data.jiraKey,
        vision: data.vision,
        targetUsers: data.targetUsers,
        constraints: data.constraints,
        existingRepo: data.existingRepo,
        previousContent: previous,
        feedback,
        model: prdModel,
        useWebSearch,
      });

      if (cancelledRef.current) return;
      if (!result.success) {
        setError(result.error || "PRD generation failed");
        setPrdPhase(previous ? "review" : "idle");
        return;
      }

      setPrdContent(result.content || "");
      setPrdUsedModel(result.usedModel || "");
      setPrdStats(result.stats || null);
      setPrdFeedback("");
      setPrdPhase("review");
      const totalCost = (result.stats?.cost ?? 0) + (result.stats?.searchStats?.cost ?? 0);
      if (totalCost > 0) onCostAdd?.(totalCost);
    } catch (e) {
      if (cancelledRef.current) return;
      setError((e as Error).message);
      setPrdPhase(previous ? "review" : "idle");
    }
  }, [data, prdModel, useWebSearch, onCostAdd]);

  const handleApprovePrd = useCallback(async () => {
    setError(null);
    await savePrdContent(data.jiraKey, prdContent);
    const result = await approvePrd(data.jiraKey);
    if (!result.success) { setError(result.error || "Failed to approve PRD"); return; }
    setPrdPhase("approved");
  }, [data.jiraKey, prdContent]);

  // ── ARD actions ───────────────────────────────────────────────────

  const handleGenerateArd = useCallback(async (previous?: string, feedback?: string) => {
    setArdPhase("generating");
    setError(null);
    cancelledRef.current = false;

    try {
      const result = await generateArd({
        projectName: data.projectName,
        jiraKey: data.jiraKey,
        prdContent,
        previousContent: previous,
        feedback,
        model: ardModel,
        useWebSearch,
      });

      if (cancelledRef.current) return;
      if (!result.success) {
        setError(result.error || "ARD generation failed");
        setArdPhase(previous ? "review" : "idle");
        return;
      }

      setArdContent(result.content || "");
      setArdUsedModel(result.usedModel || "");
      setArdStats(result.stats || null);
      setTechStack(result.techStack || "");
      setArdFeedback("");
      setArdPhase("review");
      const totalCost = (result.stats?.cost ?? 0) + (result.stats?.searchStats?.cost ?? 0);
      if (totalCost > 0) onCostAdd?.(totalCost);

      if (onChange && result.techStack) {
        onChange({ ...data, techStack: result.techStack });
      }
    } catch (e) {
      if (cancelledRef.current) return;
      setError((e as Error).message);
      setArdPhase(previous ? "review" : "idle");
    }
  }, [data, prdContent, ardModel, useWebSearch, onChange, onCostAdd]);

  const handleApproveArd = useCallback(async () => {
    setError(null);
    await saveArdContent(data.jiraKey, ardContent);
    const result = await approveArd(data.jiraKey);
    if (!result.success) { setError(result.error || "Failed to approve ARD"); return; }
    setArdPhase("approved");
  }, [data.jiraKey, ardContent]);

  // ── Cancel ────────────────────────────────────────────────────────

  const handleCancel = useCallback((doc: "prd" | "ard") => {
    cancelledRef.current = true;
    if (doc === "prd") setPrdPhase(prdContent ? "review" : "idle");
    else setArdPhase(ardContent ? "review" : "idle");
    setError("Generation cancelled.");
  }, [prdContent, ardContent]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">Architect</h2>
        <p className="text-gray-400">
          Generate your PRD first, iterate until you&apos;re happy, then generate the ARD.
          Pick a different model for each — use cloud models for best quality or local models for free.
        </p>
      </div>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-400">
          {error}
        </div>
      )}

      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={useWebSearch}
            onChange={(e) => setUseWebSearch(e.target.checked)}
            className="rounded border-zinc-600"
          />
          Enrich with web research
        </label>
        {useWebSearch && (
          <span className="ml-6 text-xs text-gray-500">
            {prdModel.startsWith("local:") || ardModel.startsWith("local:")
              ? tavilyReady ? "Local models use Tavily, cloud models use OpenRouter :online" : "Cloud models use OpenRouter :online (configure Tavily for local models)"
              : "via OpenRouter :online"}
          </span>
        )}
      </div>

      {/* PRD Panel */}
      <DocPanel
        title="PRD"
        phase={prdPhase}
        content={prdContent}
        model={prdModel}
        usedModel={prdUsedModel}
        feedback={prdFeedback}
        stats={prdStats}
        onGenerate={() => handleGeneratePrd()}
        onRegenerate={() => handleGeneratePrd(prdContent, prdFeedback || undefined)}
        onApprove={handleApprovePrd}
        onStartOver={() => {
          setPrdPhase("idle");
          setPrdContent("");
          setPrdUsedModel("");
          setPrdStats(null);
          setPrdFeedback("");
          setArdPhase("idle");
          setArdContent("");
          setArdUsedModel("");
          setArdStats(null);
          setArdFeedback("");
          setTechStack("");
        }}
        onContentChange={setPrdContent}
        onFeedbackChange={setPrdFeedback}
        onModelChange={setPrdModel}
        onCancel={() => handleCancel("prd")}
      />

      {/* ARD Panel */}
      <DocPanel
        title="ARD"
        phase={ardPhase}
        content={ardContent}
        model={ardModel}
        usedModel={ardUsedModel}
        feedback={ardFeedback}
        stats={ardStats}
        onGenerate={() => handleGenerateArd()}
        onRegenerate={() => handleGenerateArd(ardContent, ardFeedback || undefined)}
        onApprove={handleApproveArd}
        onStartOver={() => {
          setArdPhase("idle");
          setArdContent("");
          setArdUsedModel("");
          setArdStats(null);
          setArdFeedback("");
          setTechStack("");
        }}
        onContentChange={setArdContent}
        onFeedbackChange={setArdFeedback}
        onModelChange={setArdModel}
        onCancel={() => handleCancel("ard")}
        disabled={prdPhase !== "approved"}
      />

      {/* Tech Stack summary */}
      {techStack && (
        <div className="rounded-lg border border-purple-800/50 bg-purple-900/20 p-4">
          <h3 className="text-sm font-semibold text-purple-300 mb-1">Derived Tech Stack</h3>
          <p className="text-sm text-gray-300">{techStack}</p>
        </div>
      )}

      {/* Navigation */}
      {bothApproved && (
        <div className="flex justify-between">
          {onBack && (
            <button
              onClick={onBack}
              className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors cursor-pointer"
            >
              Back
            </button>
          )}
          <button
            onClick={onNext}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors ml-auto cursor-pointer"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
