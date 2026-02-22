"use client";

import { useState, useEffect, useRef } from "react";
import {
  generateBreakdown,
  approveBreakdown,
  saveBreakdownContent,
} from "../actions";
import ModelSelector from "@/components/model-selector";
import type { OnboardingData } from "../onboarding-wizard";

type BreakdownStepProps = {
  data: OnboardingData;
  onNext: () => void;
  onBack?: () => void;
  initialBreakdown?: string;
  initialStatus?: string;
};

type StoryItem = {
  summary: string;
  description: string | { objective: string; context?: string; targetFiles?: string[]; technicalApproach?: string; outOfScope?: string[] };
  storyType?: string;
  storyPoints: number;
  assigneeRole: string;
  acceptanceCriteria: (string | { criterion: string; verification: string })[];
};

type EpicItem = {
  summary: string;
  description: string;
  stories: StoryItem[];
};

type FeatureItem = {
  name: string;
  epics: EpicItem[];
};

type BreakdownData = {
  features: FeatureItem[];
};

function roleColor(role: string): string {
  switch (role) {
    case "architect": return "text-amber-400 bg-amber-900/30";
    case "dev": return "text-blue-400 bg-blue-900/30";
    case "qa": return "text-green-400 bg-green-900/30";
    default: return "text-gray-400 bg-gray-900/30";
  }
}

function pointsBadge(points: number): string {
  if (points <= 2) return "bg-green-900/30 text-green-400";
  if (points <= 5) return "bg-yellow-900/30 text-yellow-400";
  return "bg-red-900/30 text-red-400";
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function BreakdownStep({
  data,
  onNext,
  onBack,
  initialBreakdown,
  initialStatus,
}: BreakdownStepProps) {
  const [phase, setPhase] = useState<"idle" | "generating" | "review" | "approved">(
    initialStatus === "approved" ? "approved" : initialStatus === "review" ? "review" : "idle"
  );
  const [breakdown, setBreakdown] = useState<BreakdownData | null>(
    initialBreakdown ? (() => { try { return JSON.parse(initialBreakdown); } catch { return null; } })() : null
  );
  const [model, setModel] = useState("openrouter/auto");
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [expandedFeatures, setExpandedFeatures] = useState<Set<number>>(new Set([0]));
  const [expandedEpics, setExpandedEpics] = useState<Set<string>>(new Set());
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (phase === "generating") {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((p) => p + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [phase]);

  const handleGenerate = async () => {
    setPhase("generating");
    setError(null);
    setLogs([]);

    try {
      const result = await generateBreakdown({
        jiraKey: data.jiraKey,
        model,
        feedback: feedback || undefined,
      });

      if (result.success && result.content) {
        setBreakdown(JSON.parse(result.content));
        setLogs(result.logs);
        setPhase("review");
        setFeedback("");
      } else {
        setError(result.error || "Unknown error");
        setLogs(result.logs);
        setPhase(breakdown ? "review" : "idle");
      }
    } catch (e) {
      setError((e as Error).message);
      setPhase(breakdown ? "review" : "idle");
    }
  };

  const handleApprove = async () => {
    const result = await approveBreakdown(data.jiraKey);
    if (result.success) {
      setPhase("approved");
    } else {
      setError(result.error || "Failed to approve");
    }
  };

  const toggleFeature = (idx: number) => {
    setExpandedFeatures((prev) => {
      const next = new Set(prev);
      next.has(idx) ? next.delete(idx) : next.add(idx);
      return next;
    });
  };

  const toggleEpic = (key: string) => {
    setExpandedEpics((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Totals
  let totalPoints = 0;
  let totalStories = 0;
  let totalEpics = 0;
  if (breakdown) {
    for (const feature of breakdown.features) {
      for (const epic of feature.epics) {
        totalEpics++;
        for (const story of epic.stories) {
          totalStories++;
          totalPoints += story.storyPoints;
        }
      }
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Work Breakdown</h2>
        <p className="mt-1 text-sm text-gray-400">
          AI generates a structured breakdown: Features → Epics → Stories with story points and role assignments.
        </p>
      </div>

      {/* Model selector */}
      {phase !== "approved" && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-300">AI Model</label>
          <ModelSelector value={model} onChange={setModel} compact persistKey="breakdown" />
        </div>
      )}

      {/* Generate / Regenerate buttons */}
      {phase === "idle" && (
        <button
          onClick={handleGenerate}
          className="w-full rounded-lg bg-purple-600 px-4 py-3 font-medium text-white hover:bg-purple-500 transition-colors cursor-pointer"
        >
          Generate Work Breakdown
        </button>
      )}

      {/* Generating spinner */}
      {phase === "generating" && (
        <div className="flex flex-col items-center gap-3 py-6">
          <div className="h-10 w-10 animate-spin rounded-full border-3 border-gray-600 border-t-purple-500" />
          <p className="text-gray-300 font-medium">Generating work breakdown...</p>
          <span className="font-mono text-purple-400 text-sm">{formatElapsed(elapsed)}</span>
          <div className="w-64 h-1.5 bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-gradient-to-r from-purple-500 to-blue-500 rounded-full animate-pulse"
              style={{ width: `${Math.min(95, (elapsed / 120) * 100)}%`, transition: "width 1s linear" }}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-800 bg-red-900/20 p-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {/* Breakdown tree view */}
      {breakdown && phase !== "generating" && (
        <>
          {/* Summary bar */}
          <div className="flex gap-4 rounded-lg border border-gray-700 bg-gray-800/50 p-3">
            <div className="text-center">
              <div className="text-lg font-bold text-white">{breakdown.features.length}</div>
              <div className="text-xs text-gray-400">Features</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-white">{totalEpics}</div>
              <div className="text-xs text-gray-400">Epics</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-white">{totalStories}</div>
              <div className="text-xs text-gray-400">Stories</div>
            </div>
            <div className="text-center">
              <div className="text-lg font-bold text-purple-400">{totalPoints}</div>
              <div className="text-xs text-gray-400">Total Points</div>
            </div>
          </div>

          {/* Tree */}
          <div className="space-y-2">
            {breakdown.features.map((feature, fi) => (
              <div key={fi} className="rounded-lg border border-gray-700 overflow-hidden">
                <button
                  onClick={() => toggleFeature(fi)}
                  className="w-full flex items-center justify-between p-3 bg-gray-800/50 hover:bg-gray-800 transition-colors text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-gray-500">{expandedFeatures.has(fi) ? "▼" : "▶"}</span>
                    <span className="font-medium text-white">{feature.name}</span>
                  </div>
                  <span className="text-xs text-gray-400">
                    {feature.epics.length} epics,{" "}
                    {feature.epics.reduce((s, e) => s + e.stories.length, 0)} stories,{" "}
                    {feature.epics.reduce((s, e) => s + e.stories.reduce((ss, st) => ss + st.storyPoints, 0), 0)} pts
                  </span>
                </button>

                {expandedFeatures.has(fi) && (
                  <div className="border-t border-gray-700 pl-4">
                    {feature.epics.map((epic, ei) => {
                      const epicKey = `${fi}-${ei}`;
                      return (
                        <div key={ei} className="border-b border-gray-800 last:border-b-0">
                          <button
                            onClick={() => toggleEpic(epicKey)}
                            className="w-full flex items-center justify-between p-2 hover:bg-gray-800/30 transition-colors text-left cursor-pointer"
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-gray-500 text-xs">{expandedEpics.has(epicKey) ? "▼" : "▶"}</span>
                              <span className="text-sm text-purple-300 font-medium">{epic.summary}</span>
                            </div>
                            <span className="text-xs text-gray-500">
                              {epic.stories.length} stories,{" "}
                              {epic.stories.reduce((s, st) => s + st.storyPoints, 0)} pts
                            </span>
                          </button>

                          {expandedEpics.has(epicKey) && (
                            <div className="pl-6 pb-2 space-y-1">
                              {epic.stories.map((story, si) => (
                                <div
                                  key={si}
                                  className="rounded p-2 bg-gray-900/50 text-sm"
                                >
                                  <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${roleColor(story.assigneeRole)}`}>
                                        {story.assigneeRole}
                                      </span>
                                      {story.storyType && (
                                        <span className="shrink-0 rounded px-1.5 py-0.5 text-xs text-gray-500 bg-gray-800">
                                          {story.storyType}
                                        </span>
                                      )}
                                      <span className="text-gray-200 truncate">{story.summary}</span>
                                    </div>
                                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-bold ${pointsBadge(story.storyPoints)}`}>
                                      {story.storyPoints}
                                    </span>
                                  </div>
                                  {/* Description */}
                                  {typeof story.description === "string" ? (
                                    <p className="text-xs text-zinc-400 mt-1 truncate">{story.description}</p>
                                  ) : (
                                    <div className="text-xs text-zinc-400 mt-1 space-y-0.5">
                                      <p>{story.description.objective}</p>
                                      {story.description.targetFiles && story.description.targetFiles.length > 0 && (
                                        <p className="text-zinc-500">
                                          Files: {story.description.targetFiles.map(f => (
                                            <code key={f} className="text-xs bg-zinc-800 px-1 rounded mx-0.5">{f}</code>
                                          ))}
                                        </p>
                                      )}
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Actions for review phase */}
          {phase === "review" && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <button
                  onClick={handleApprove}
                  className="flex-1 rounded-lg bg-green-600 px-4 py-2.5 font-medium text-white hover:bg-green-500 transition-colors cursor-pointer"
                >
                  Approve Breakdown
                </button>
                <button
                  onClick={handleGenerate}
                  className="rounded-lg border border-gray-600 px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer"
                >
                  Regenerate
                </button>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-gray-400">Feedback for regeneration (optional)</label>
                <textarea
                  value={feedback}
                  onChange={(e) => setFeedback(e.target.value)}
                  placeholder="e.g. Split the auth epic into smaller stories, add more QA coverage..."
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 resize-none"
                  rows={2}
                />
              </div>
            </div>
          )}
        </>
      )}

      {/* Approved */}
      {phase === "approved" && (
        <div className="rounded-lg border border-green-800 bg-green-900/20 p-3 text-sm text-green-300">
          Work breakdown approved. Issues will be created in Jira during the execution step.
        </div>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-300">Generation logs</summary>
          <pre className="mt-2 overflow-auto rounded-lg bg-black p-3 text-gray-400 max-h-40">
            {logs.join("\n")}
          </pre>
        </details>
      )}

      {/* Navigation */}
      <div className="flex justify-between pt-2">
        <button
          onClick={onBack}
          className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-800 transition-colors cursor-pointer"
        >
          Back
        </button>
        <button
          onClick={onNext}
          disabled={phase !== "approved"}
          className="rounded-lg bg-blue-600 px-6 py-2 font-medium text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
        >
          Next
        </button>
      </div>
    </div>
  );
}
