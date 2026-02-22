"use client";

import { useState, useEffect, useCallback } from "react";
import type { OnboardingData } from "../onboarding-wizard";
import Link from "next/link";
import { api } from "@/lib/api";
import { getProjectTeamConfig } from "../actions";

type ExecStepStatus = "pending" | "running" | "success" | "failed" | "skipped";

type ExecStep = {
  name: string;
  status: ExecStepStatus;
  logs: string[];
  error?: string;
};

const STEP_NAMES = [
  "GitHub",
  "Jira",
  "Work Breakdown",
  "Scaffold",
  "Team Setup",
  "Slack Channel",
  "Validation",
];

type ReviewExecuteStepProps = {
  data: OnboardingData;
  onBack?: () => void;
};

export default function ReviewExecuteStep({ data, onBack }: ReviewExecuteStepProps) {
  const [execSteps, setExecSteps] = useState<ExecStep[]>(
    STEP_NAMES.map((n) => ({ name: n, status: "pending", logs: [] }))
  );
  const [activeExecStep, setActiveExecStep] = useState(0);
  const [isRunningAll, setIsRunningAll] = useState(false);
  const [teamSummary, setTeamSummary] = useState<{ totalTeams: number; totalAgents: number }>({
    totalTeams: 0,
    totalAgents: 0,
  });

  const repoName = data.projectName.toLowerCase().replace(/\s+/g, "-");

  // Load team config summary
  useEffect(() => {
    getProjectTeamConfig(data.jiraKey).then((result) => {
      if (result.totalTeams > 0) {
        setTeamSummary({ totalTeams: result.totalTeams, totalAgents: result.totalAgents });
      }
    });
  }, [data.jiraKey]);

  const allDone = execSteps.every(
    (s) => s.status === "success" || s.status === "skipped"
  );
  const currentStep = execSteps[activeExecStep];
  const isRunning = currentStep?.status === "running" || isRunningAll;

  const runStep = useCallback(
    async (index: number) => {
      const step = execSteps[index];
      if (!step) return;

      setExecSteps((prev) =>
        prev.map((s, i) =>
          i === index ? { ...s, status: "running", logs: [], error: undefined } : s
        )
      );

      try {
        const response = await fetch(api("/api/onboarding/execute-step"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jiraKey: data.jiraKey, step: step.name }),
        });

        const result = await response.json();

        setExecSteps((prev) =>
          prev.map((s, i) =>
            i === index
              ? {
                  ...s,
                  status: result.success ? "success" : "failed",
                  logs: result.logs || [],
                  error: result.error,
                }
              : s
          )
        );

        return result.success as boolean;
      } catch (e) {
        setExecSteps((prev) =>
          prev.map((s, i) =>
            i === index
              ? { ...s, status: "failed", logs: [], error: (e as Error).message }
              : s
          )
        );
        return false;
      }
    },
    [execSteps, data.jiraKey]
  );

  const handleRun = useCallback(async () => {
    const success = await runStep(activeExecStep);
    if (success && activeExecStep < STEP_NAMES.length - 1) {
      setActiveExecStep((prev) => prev + 1);
    }
  }, [runStep, activeExecStep]);

  const handleSkip = useCallback(() => {
    setExecSteps((prev) =>
      prev.map((s, i) =>
        i === activeExecStep ? { ...s, status: "skipped", logs: ["Skipped by user"] } : s
      )
    );
    if (activeExecStep < STEP_NAMES.length - 1) {
      setActiveExecStep((prev) => prev + 1);
    }
  }, [activeExecStep]);

  const handleExecuteAll = useCallback(async () => {
    setIsRunningAll(true);

    for (let i = 0; i < STEP_NAMES.length; i++) {
      const step = execSteps[i];
      if (step.status === "success" || step.status === "skipped") continue;

      setActiveExecStep(i);
      const success = await runStep(i);

      if (!success) {
        setIsRunningAll(false);
        return;
      }
    }

    setIsRunningAll(false);
  }, [execSteps, runStep]);

  const canGoNext =
    currentStep?.status === "success" || currentStep?.status === "skipped";
  const canRun =
    currentStep?.status === "pending" || currentStep?.status === "failed";
  const canSkip =
    (currentStep?.status === "pending" || currentStep?.status === "failed") &&
    currentStep?.name !== "Validation";
  const hasPendingSteps = execSteps.some(
    (s) => s.status === "pending" || s.status === "failed"
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">
          Review & Execute
        </h2>
        <p className="text-gray-400">
          Run each setup step individually. Retry any failed step without
          re-running previous ones.
        </p>
      </div>

      {/* Summary */}
      <div className="bg-gray-800 rounded-lg p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-100">
          Configuration Summary
        </h3>

        <div className="grid grid-cols-[120px_1fr] gap-y-2 gap-x-4 text-sm">
          <span className="text-gray-500">Project</span>
          <span className="text-gray-200">{data.projectName}</span>

          <span className="text-gray-500">Path</span>
          <span className="text-gray-200 font-mono text-xs">
            {data.localPath}
          </span>

          <span className="text-gray-500">Jira Key</span>
          <span className="text-gray-200 font-mono">{data.jiraKey}</span>

          <span className="text-gray-500">Vision</span>
          <span className="text-gray-200 line-clamp-2">
            {data.vision.split("\n").slice(0, 2).join(" ")}
          </span>

          {data.techStack && (
            <>
              <span className="text-gray-500">Tech Stack</span>
              <span className="text-gray-200">{data.techStack}</span>
            </>
          )}

          <span className="text-gray-500">GitHub</span>
          <span className="text-gray-200">
            {data.githubMode === "create"
              ? `Create new: michaelbaker-dev/${repoName}`
              : `Use existing: ${data.existingRepo}`}
          </span>

          <span className="text-gray-500">Jira Project</span>
          <span className="text-gray-200">
            {data.jiraKey} ({data.projectName})
          </span>

          <span className="text-gray-500">Files</span>
          <span className="text-gray-200">8 files to scaffold</span>

          <span className="text-gray-500">Team</span>
          <span className="text-gray-200">
            {teamSummary.totalTeams > 0
              ? `${teamSummary.totalTeams} teams, ${teamSummary.totalAgents} agents`
              : "Default template"}
          </span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="flex items-center gap-1">
        {execSteps.map((step, i) => {
          const isActive = i === activeExecStep;
          let bgClass = "bg-gray-700";
          if (step.status === "running") bgClass = "bg-blue-500 animate-pulse";
          else if (step.status === "success") bgClass = "bg-green-500";
          else if (step.status === "failed") bgClass = "bg-red-500";
          else if (step.status === "skipped") bgClass = "bg-yellow-500";

          let textClass = "text-gray-500";
          if (step.status === "running") textClass = "text-blue-300";
          else if (step.status === "success") textClass = "text-green-400";
          else if (step.status === "failed") textClass = "text-red-400";
          else if (step.status === "skipped") textClass = "text-yellow-400";
          else if (isActive) textClass = "text-gray-300";

          return (
            <button
              key={step.name}
              onClick={() => !isRunning && setActiveExecStep(i)}
              disabled={isRunning}
              className={`flex-1 flex flex-col items-center gap-1 transition-opacity ${
                isActive ? "opacity-100" : "opacity-60 hover:opacity-80"
              } ${isRunning ? "cursor-not-allowed" : "cursor-pointer"}`}
            >
              <div
                className={`h-2 w-full rounded-full ${bgClass} ${
                  isActive ? "ring-2 ring-blue-400/50" : ""
                }`}
              />
              <span className={`text-xs ${textClass}`}>{step.name}</span>
            </button>
          );
        })}
      </div>

      {/* Active step card */}
      <div className="space-y-3">
        {execSteps.map((step, i) => {
          const isActive = i === activeExecStep;
          const showCard =
            isActive || step.status === "success" || step.status === "failed" || step.status === "skipped";

          if (!showCard) return null;

          return (
            <div
              key={step.name}
              className={`rounded-lg border bg-gray-800 ${
                isActive
                  ? "border-blue-600/50 ring-1 ring-blue-600/20"
                  : "border-gray-700"
              }`}
            >
              <div className="flex items-center gap-3 px-4 py-3">
                {step.status === "running" && (
                  <div className="h-5 w-5 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500 shrink-0" />
                )}
                {step.status === "success" && (
                  <svg
                    className="w-5 h-5 text-green-400 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
                {step.status === "failed" && (
                  <svg
                    className="w-5 h-5 text-red-400 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
                {step.status === "skipped" && (
                  <svg
                    className="w-5 h-5 text-yellow-400 shrink-0"
                    fill="currentColor"
                    viewBox="0 0 20 20"
                  >
                    <path
                      fillRule="evenodd"
                      d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                      clipRule="evenodd"
                    />
                  </svg>
                )}
                {step.status === "pending" && (
                  <div className="h-5 w-5 rounded-full border-2 border-gray-600 shrink-0" />
                )}

                <span className="font-medium text-gray-100">{step.name}</span>

                <span
                  className={`text-xs ml-auto px-2 py-0.5 rounded-full ${
                    step.status === "running"
                      ? "bg-blue-900/50 text-blue-300"
                      : step.status === "success"
                        ? "bg-green-900/50 text-green-400"
                        : step.status === "failed"
                          ? "bg-red-900/50 text-red-400"
                          : step.status === "skipped"
                            ? "bg-yellow-900/50 text-yellow-400"
                            : "bg-gray-700 text-gray-500"
                  }`}
                >
                  {step.status === "running" ? "running..." : step.status}
                </span>
              </div>

              {step.logs.length > 0 && (
                <div className="border-t border-gray-700 px-4 py-2">
                  <pre className="text-xs text-gray-400 font-mono overflow-x-auto whitespace-pre-wrap">
                    {step.logs.join("\n")}
                  </pre>
                </div>
              )}
              {step.error && (
                <div className="border-t border-gray-700 px-4 py-2">
                  <p className="text-xs text-red-400">{step.error}</p>
                </div>
              )}

              {/* Per-step action buttons */}
              {isActive && !isRunningAll && (
                <div className="border-t border-gray-700 px-4 py-2 flex items-center gap-2">
                  {canRun && (
                    <button
                      onClick={handleRun}
                      disabled={step.status === "running"}
                      className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
                    >
                      {step.status === "failed" ? "Retry" : "Run"}
                    </button>
                  )}
                  {canSkip && (
                    <button
                      onClick={handleSkip}
                      disabled={step.status === "running"}
                      className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 disabled:cursor-not-allowed text-white text-sm font-medium rounded-md transition-colors"
                    >
                      Skip
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Success state */}
      {allDone && (
        <div className="rounded-lg border border-green-800/50 bg-green-900/20 p-4 text-center space-y-3">
          <p className="text-green-400 font-semibold text-lg">
            Onboarding Complete!
          </p>
          <p className="text-gray-400 text-sm">
            All resources have been created. Your project is ready for AI-driven
            development.
          </p>
          <Link
            href="/"
            className="inline-block px-6 py-2 bg-green-600 hover:bg-green-700 text-white font-medium rounded-lg transition-colors"
          >
            Go to Dashboard
          </Link>
        </div>
      )}

      {/* Navigation */}
      {!allDone && (
        <div className="flex justify-between items-center">
          <div className="flex gap-2">
            {onBack && activeExecStep === 0 && (
              <button
                onClick={onBack}
                disabled={isRunning}
                className="px-6 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
              >
                Back
              </button>
            )}
            {activeExecStep > 0 && (
              <button
                onClick={() => setActiveExecStep((prev) => prev - 1)}
                disabled={isRunning}
                className="px-6 py-2 bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
              >
                Back
              </button>
            )}
            {canGoNext && activeExecStep < STEP_NAMES.length - 1 && (
              <button
                onClick={() => setActiveExecStep((prev) => prev + 1)}
                disabled={isRunning}
                className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
              >
                Next
              </button>
            )}
          </div>

          {hasPendingSteps && (
            <button
              onClick={handleExecuteAll}
              disabled={isRunning}
              className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition-colors"
            >
              {isRunningAll ? "Executing..." : "Execute All"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
