"use client";

import { useState, useEffect, useRef } from "react";
import { validateProject, generateVision, checkTavilyConfigured } from "../actions";
import type { SearchStats } from "../actions";
import ModelSelector from "@/components/model-selector";
import type { OnboardingData } from "../onboarding-wizard";

type ProjectInfoStepProps = {
  data: OnboardingData;
  onChange?: (data: OnboardingData) => void;
  onNext: () => void;
  onCostAdd?: (cost: number) => void;
};

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

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function ProjectInfoStep({
  data,
  onChange,
  onNext,
  onCostAdd,
}: ProjectInfoStepProps) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isValidating, setIsValidating] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);

  // AI Assist state
  const [aiExpanded, setAiExpanded] = useState(false);
  const [visionModel, setVisionModel] = useState("openrouter/auto");
  const [isGenerating, setIsGenerating] = useState(false);
  const [visionStats, setVisionStats] = useState<DocStats | null>(null);
  const [visionFeedback, setVisionFeedback] = useState("");
  const [useWebSearch, setUseWebSearch] = useState(false);
  const [tavilyReady, setTavilyReady] = useState(false);
  const [hasGenerated, setHasGenerated] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    checkTavilyConfigured().then(setTavilyReady);
  }, []);

  useEffect(() => {
    if (isGenerating) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [isGenerating]);

  const handleChange = (field: keyof OnboardingData, value: string) => {
    if (onChange) {
      onChange({ ...data, [field]: value });
    }
    if (errors[field]) {
      setErrors({ ...errors, [field]: "" });
    }
  };

  const handleGenerateVision = async (isRegenerate = false) => {
    if (!data.vision.trim() && !isRegenerate) return;
    setIsGenerating(true);
    setGenError(null);
    cancelledRef.current = false;

    const result = await generateVision({
      projectName: data.projectName || "Untitled",
      jiraKey: data.jiraKey || "TEMP",
      roughInput: data.vision,
      targetUsers: data.targetUsers || undefined,
      constraints: data.constraints || undefined,
      existingRepo: data.existingRepo || undefined,
      previousContent: isRegenerate ? data.vision : undefined,
      feedback: isRegenerate ? visionFeedback : undefined,
      model: visionModel,
      useWebSearch,
    });

    if (cancelledRef.current) {
      setIsGenerating(false);
      return;
    }

    if (result.success && result.content) {
      handleChange("vision", result.content);
      setVisionStats(result.stats || null);
      setHasGenerated(true);
      setVisionFeedback("");
      const totalCost = (result.stats?.cost ?? 0) + (result.stats?.searchStats?.cost ?? 0);
      if (totalCost > 0) onCostAdd?.(totalCost);
    } else {
      setGenError(result.error || "Generation failed");
    }
    setIsGenerating(false);
  };

  const handleCancel = () => {
    cancelledRef.current = true;
    setIsGenerating(false);
  };

  const validateAndNext = async () => {
    const newErrors: Record<string, string> = {};

    if (!data.projectName.trim()) newErrors.projectName = "Project name is required";
    if (!data.localPath.trim()) newErrors.localPath = "Local path is required";
    if (!data.jiraKey.trim()) newErrors.jiraKey = "Jira key is required";
    if (!data.vision.trim()) newErrors.vision = "Project vision is required";

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    setIsValidating(true);
    setLogs([]);

    const result = await validateProject({
      projectName: data.projectName,
      localPath: data.localPath,
      jiraKey: data.jiraKey,
      vision: data.vision,
      targetUsers: data.targetUsers,
      constraints: data.constraints,
      existingRepo: data.existingRepo,
      archProfile: data.archProfile,
    });
    setLogs(result.logs);

    if (result.success) {
      onNext();
    } else {
      setErrors({ _server: result.error || "Validation failed" });
    }
    setIsValidating(false);
  };

  const isLocal = visionModel.startsWith("local:");
  const hasVisionText = data.vision.trim().length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">Project Vision</h2>
        <p className="text-gray-400">
          Describe what you want to build. The Architect agent will determine the
          tech stack and generate a PRD + ARD in the next step.
        </p>
      </div>

      {errors._server && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-400">
          {errors._server}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <label htmlFor="projectName" className="block text-sm font-medium text-gray-300 mb-2">
            Project Name
          </label>
          <input
            id="projectName"
            type="text"
            value={data.projectName}
            onChange={(e) => handleChange("projectName", e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            placeholder="HelloWorld"
          />
          {errors.projectName && <p className="mt-1 text-sm text-red-400">{errors.projectName}</p>}
        </div>

        <div>
          <label htmlFor="localPath" className="block text-sm font-medium text-gray-300 mb-2">
            Local Path
          </label>
          <input
            id="localPath"
            type="text"
            value={data.localPath}
            onChange={(e) => handleChange("localPath", e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            placeholder="~/code/helloworld"
          />
          {errors.localPath && <p className="mt-1 text-sm text-red-400">{errors.localPath}</p>}
        </div>

        <div>
          <label htmlFor="jiraKey" className="block text-sm font-medium text-gray-300 mb-2">
            Jira Project Key
          </label>
          <input
            id="jiraKey"
            type="text"
            value={data.jiraKey}
            onChange={(e) => handleChange("jiraKey", e.target.value.toUpperCase())}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            placeholder="HELLO"
          />
          {errors.jiraKey && <p className="mt-1 text-sm text-red-400">{errors.jiraKey}</p>}
        </div>

        <div>
          <label htmlFor="vision" className="block text-sm font-medium text-gray-300 mb-2">
            Project Vision
          </label>
          <textarea
            id="vision"
            value={data.vision}
            onChange={(e) => handleChange("vision", e.target.value)}
            rows={8}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent resize-none"
            placeholder={`Describe your product vision:\n\u2022 What does this product do?\n\u2022 Who is it for?\n\u2022 What are the core features?\n\u2022 What problem does it solve?\n\u2022 What does success look like?`}
          />
          {errors.vision && <p className="mt-1 text-sm text-red-400">{errors.vision}</p>}

          {/* AI Assist Section */}
          {hasVisionText && (
            <div className="mt-2">
              <button
                onClick={() => setAiExpanded(!aiExpanded)}
                className="flex items-center gap-2 text-sm text-purple-400 hover:text-purple-300 transition-colors cursor-pointer"
              >
                <svg className={`w-4 h-4 transition-transform ${aiExpanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                AI Assist — expand rough notes into a polished vision
              </button>

              {aiExpanded && (
                <div className="mt-3 rounded-lg border border-gray-700 bg-gray-800/50 p-4 space-y-4">
                  {/* Generating spinner */}
                  {isGenerating ? (
                    <div className="flex flex-col items-center gap-3 py-6">
                      <div className="h-10 w-10 animate-spin rounded-full border-3 border-gray-600 border-t-purple-500" />
                      <p className="text-gray-300 font-medium">Expanding vision...</p>
                      <div className="flex items-center gap-2 text-sm">
                        <span className="font-mono text-purple-400">{formatElapsed(elapsed)}</span>
                        <span className="text-gray-500">elapsed</span>
                      </div>
                      <p className="text-sm text-gray-500 text-center max-w-md">
                        {isLocal
                          ? elapsed < 5
                            ? "Sending request to LM Studio..."
                            : elapsed < 30
                            ? "Local model is generating..."
                            : "Large local models can take a while..."
                          : elapsed < 5
                          ? "Sending request to OpenRouter..."
                          : elapsed < 15
                          ? "Generating polished vision..."
                          : "Still generating..."}
                      </p>
                      <div className="w-64 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full animate-pulse"
                          style={{ width: `${Math.min(95, (elapsed / (isLocal ? 300 : 60)) * 100)}%`, transition: "width 1s linear" }}
                        />
                      </div>
                      <button
                        onClick={handleCancel}
                        className="mt-1 px-4 py-1.5 text-sm text-gray-400 hover:text-white border border-gray-700 hover:border-gray-500 rounded-lg transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <>
                      {/* Model selector + options */}
                      <ModelSelector value={visionModel} onChange={setVisionModel} compact persistKey="vision" />

                      {(tavilyReady || !isLocal) && (
                        <div className="space-y-1">
                          <label className="flex items-center gap-2 text-sm text-gray-400 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={useWebSearch}
                              onChange={(e) => setUseWebSearch(e.target.checked)}
                              disabled={isLocal && !tavilyReady}
                              className="rounded border-gray-600 bg-gray-700 text-purple-500 focus:ring-purple-500"
                            />
                            Enrich with web research
                          </label>
                          {useWebSearch && (
                            <span className="ml-6 text-xs text-gray-500">
                              {isLocal
                                ? tavilyReady ? "via Tavily" : "Configure Tavily API key in Settings"
                                : "via OpenRouter :online"}
                            </span>
                          )}
                        </div>
                      )}

                      {genError && (
                        <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-400">
                          {genError}
                        </div>
                      )}

                      {/* Stats bar */}
                      {visionStats && (
                        <div className="space-y-2 text-xs">
                          {visionStats.searchStats && (
                            <div className="flex flex-wrap gap-3">
                              <span className="px-2 py-1 rounded bg-blue-900/20 border border-blue-800/40 text-blue-400">
                                Search: ${visionStats.searchStats.cost.toFixed(2)}
                              </span>
                              <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                                {visionStats.searchStats.provider === "openrouter" ? "OpenRouter :online" : "Tavily"}
                              </span>
                              <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                                {visionStats.searchStats.resultCount} results
                              </span>
                              {visionStats.searchStats.durationMs > 0 && (
                                <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                                  {formatDuration(visionStats.searchStats.durationMs)}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="flex flex-wrap gap-3">
                            {visionStats.searchStats && (
                              <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-500 font-medium">
                                LLM
                              </span>
                            )}
                            <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                              {visionStats.promptTokens.toLocaleString()} in / {visionStats.completionTokens.toLocaleString()} out
                            </span>
                            <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                              {visionStats.tokensPerSecond} tok/s
                            </span>
                            <span className="px-2 py-1 rounded bg-gray-800 border border-gray-700 text-gray-400">
                              {formatDuration(visionStats.durationMs)}
                            </span>
                            {visionStats.cost > 0 ? (
                              <span className="px-2 py-1 rounded bg-purple-900/30 border border-purple-800/50 text-purple-400">
                                ${visionStats.cost.toFixed(4)}
                              </span>
                            ) : (
                              <span className="px-2 py-1 rounded bg-emerald-900/30 border border-emerald-800/50 text-emerald-400">
                                Free
                              </span>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Feedback + Regenerate (after first generation) */}
                      {hasGenerated && (
                        <div className="space-y-3">
                          <textarea
                            value={visionFeedback}
                            onChange={(e) => setVisionFeedback(e.target.value)}
                            rows={2}
                            className="w-full px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-200 text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-600 focus:border-transparent resize-none"
                            placeholder="Feedback — e.g. 'emphasize mobile-first', 'add offline support', 'make it more concise'"
                          />
                          <button
                            onClick={() => handleGenerateVision(true)}
                            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
                          >
                            Regenerate
                          </button>
                        </div>
                      )}

                      {/* Initial generate button */}
                      {!hasGenerated && (
                        <button
                          onClick={() => handleGenerateVision(false)}
                          className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white text-sm font-medium rounded-lg transition-colors cursor-pointer"
                        >
                          Expand Vision with AI
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        <div>
          <label htmlFor="targetUsers" className="block text-sm font-medium text-gray-300 mb-2">
            Target Users <span className="text-gray-500">(optional)</span>
          </label>
          <input
            id="targetUsers"
            type="text"
            value={data.targetUsers}
            onChange={(e) => handleChange("targetUsers", e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            placeholder="e.g. Small business owners, developers, students"
          />
        </div>

        <div>
          <label htmlFor="constraints" className="block text-sm font-medium text-gray-300 mb-2">
            Constraints & Preferences <span className="text-gray-500">(optional)</span>
          </label>
          <textarea
            id="constraints"
            value={data.constraints}
            onChange={(e) => handleChange("constraints", e.target.value)}
            rows={3}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent resize-none"
            placeholder="e.g. Must support mobile, prefer PostgreSQL, budget under $50/mo hosting"
          />
        </div>

        <div>
          <label htmlFor="existingRepo" className="block text-sm font-medium text-gray-300 mb-2">
            Existing Codebase URL <span className="text-gray-500">(optional)</span>
          </label>
          <input
            id="existingRepo"
            type="text"
            value={data.existingRepo}
            onChange={(e) => handleChange("existingRepo", e.target.value)}
            className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
            placeholder="https://github.com/org/repo (leave blank for greenfield)"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Architecture Profile
          </label>
          <div className="space-y-3">
            <label
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                data.archProfile === "simple"
                  ? "border-blue-500 bg-blue-900/20"
                  : "border-gray-700 bg-gray-800 hover:border-gray-600"
              }`}
            >
              <input
                type="radio"
                name="archProfile"
                value="simple"
                checked={data.archProfile === "simple"}
                onChange={() => handleChange("archProfile", "simple")}
                className="mt-1 text-blue-600"
              />
              <div>
                <p className="font-medium text-gray-100">Simple</p>
                <p className="text-sm text-gray-400">
                  Single environment. PRs merge directly to main. Best for small projects and MVPs.
                </p>
              </div>
            </label>
            <label
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                data.archProfile === "complex"
                  ? "border-blue-500 bg-blue-900/20"
                  : "border-gray-700 bg-gray-800 hover:border-gray-600"
              }`}
            >
              <input
                type="radio"
                name="archProfile"
                value="complex"
                checked={data.archProfile === "complex"}
                onChange={() => handleChange("archProfile", "complex")}
                className="mt-1 text-blue-600"
              />
              <div>
                <p className="font-medium text-gray-100">Complex</p>
                <p className="text-sm text-gray-400">
                  Dev/QA/Prod isolation. PRs merge to develop, promoted to main after testing. Best for team projects with CI/CD.
                </p>
              </div>
            </label>
          </div>
        </div>
      </div>

      {logs.length > 0 && (
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
          <pre className="text-sm text-gray-300 font-mono overflow-x-auto">
            <code>{logs.join("\n")}</code>
          </pre>
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={validateAndNext}
          disabled={isValidating}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
        >
          {isValidating ? "Validating..." : "Next"}
        </button>
      </div>
    </div>
  );
}
