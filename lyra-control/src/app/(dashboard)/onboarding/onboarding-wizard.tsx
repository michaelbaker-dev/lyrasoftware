"use client";

import { useState, useCallback, useMemo } from "react";

import StepProgress from "@/components/step-progress";
import ProjectInfoStep from "./components/project-info-step";
import CodebaseAnalysisStep from "./components/codebase-analysis-step";
import ArchitectStep from "./components/architect-step";
import BreakdownStep from "./components/breakdown-step";
import GitHubStep from "./components/github-step";
import JiraStep from "./components/jira-step";
import ScaffoldStep from "./components/scaffold-step";
import LyraTeamStep from "./components/lyra-team-step";
import ReviewExecuteStep from "./components/review-execute-step";
import { saveOnboardingStep } from "./actions";

export type OnboardingData = {
  projectName: string;
  localPath: string;
  jiraKey: string;
  vision: string;
  targetUsers: string;
  constraints: string;
  existingRepo: string;
  techStack: string;
  description: string;
  githubMode: "create" | "existing";
  archProfile: "simple" | "complex";
};

const BASE_STEPS = [
  { name: "Vision", description: "Name, path, vision" },
  { name: "Architect", description: "Generate PRD & ARD" },
  { name: "Breakdown", description: "Work breakdown" },
  { name: "GitHub", description: "Repo config" },
  { name: "Jira", description: "Project config" },
  { name: "Scaffold", description: "Preview files" },
  { name: "Team Setup", description: "Preview agents" },
  { name: "Review", description: "Execute all" },
];

const ANALYSIS_STEP = { name: "Analysis", description: "Codebase analysis" };

type WizardProps = {
  initialData: OnboardingData;
  initialStep: number;
  initialStatuses: ("pending" | "running" | "completed" | "failed")[];
  resumingProjectId: string | null;
  initialPrd?: string;
  initialArd?: string;
  initialPrdStatus?: string;
  initialBreakdown?: string;
  initialBreakdownStatus?: string;
  hasExistingCodebase?: boolean;
  initialSessionCost?: number;
};

export default function OnboardingWizard({
  initialData,
  initialStep,
  initialStatuses,
  resumingProjectId,
  initialPrd,
  initialArd,
  initialPrdStatus,
  initialBreakdown,
  initialBreakdownStatus,
  hasExistingCodebase = false,
  initialSessionCost,
}: WizardProps) {
  const [currentStep, setCurrentStep] = useState(initialStep);
  const [data, setData] = useState<OnboardingData>(initialData);
  const [showAnalysis, setShowAnalysis] = useState(hasExistingCodebase);
  const [sessionCost, setSessionCost] = useState(initialSessionCost ?? 0);
  const addCost = useCallback((cost: number) => {
    setSessionCost(prev => prev + cost);
  }, []);
  const [stepStatuses, setStepStatuses] = useState<
    ("pending" | "running" | "completed" | "failed")[]
  >(initialStatuses);

  // Build step list dynamically based on whether analysis step is shown
  // Existing codebase: Vision → GitHub → Analysis → Architect → Breakdown → Jira → Scaffold → Team → Review
  // New project:       Vision → Architect → Breakdown → GitHub → Jira → Scaffold → Team → Review
  const steps = useMemo(() => {
    if (showAnalysis) {
      return [
        BASE_STEPS[0],          // Vision
        BASE_STEPS[3],          // GitHub (moved before Analysis)
        ANALYSIS_STEP,          // Analysis
        BASE_STEPS[1],          // Architect
        BASE_STEPS[2],          // Breakdown
        ...BASE_STEPS.slice(4), // Jira, Scaffold, Team Setup, Review
      ];
    }
    return BASE_STEPS;
  }, [showAnalysis]);

  const updateStatus = (
    index: number,
    status: "pending" | "running" | "completed" | "failed"
  ) => {
    setStepStatuses((prev) => {
      const next = [...prev];
      next[index] = status;
      return next;
    });
  };

  const persistStep = useCallback(
    (step: number) => {
      if (data.jiraKey) {
        saveOnboardingStep(data.jiraKey, step);
      }
    },
    [data.jiraKey]
  );

  const handleNext = () => {
    updateStatus(currentStep, "completed");
    if (currentStep < steps.length - 1) {
      const next = currentStep + 1;
      setCurrentStep(next);
      persistStep(next);
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      const prev = currentStep - 1;
      setCurrentStep(prev);
      persistStep(prev);
    }
  };

  const handleStepClick = (index: number) => {
    setCurrentStep(index);
    persistStep(index);
  };

  // When ProjectInfoStep completes, check if existing codebase to show analysis
  const handleProjectInfoNext = () => {
    // Detect existing codebase: if localPath has files and existingRepo is set
    const hasExisting = Boolean(data.existingRepo?.trim());
    if (hasExisting && !showAnalysis) {
      setShowAnalysis(true);
      // Rebuild statuses: existing flow has 9 steps (1 extra), first step completed
      const newStatuses = Array(BASE_STEPS.length + 1).fill("pending") as ("pending" | "running" | "completed" | "failed")[];
      newStatuses[0] = "completed";
      setStepStatuses(newStatuses);
    } else if (!hasExisting && showAnalysis) {
      setShowAnalysis(false);
      // Rebuild statuses: new project flow has 8 steps, first step completed
      const newStatuses = Array(BASE_STEPS.length).fill("pending") as ("pending" | "running" | "completed" | "failed")[];
      newStatuses[0] = "completed";
      setStepStatuses(newStatuses);
    }
    handleNext();
  };

  const architectPhase = initialPrdStatus === "approved"
    ? "approved"
    : initialPrdStatus === "review"
      ? "review"
      : "idle";

  // Build step components dynamically
  const baseComponents = [
    <ProjectInfoStep
      key="info"
      data={data}
      onChange={setData}
      onNext={handleProjectInfoNext}
      onCostAdd={addCost}
    />,
    <ArchitectStep
      key="architect"
      data={data}
      onChange={setData}
      onNext={handleNext}
      onBack={handleBack}
      initialPrd={initialPrd}
      initialArd={initialArd}
      initialPhase={architectPhase as "idle" | "review" | "approved"}
      initialTechStack={initialData.techStack}
      onCostAdd={addCost}
    />,
    <BreakdownStep
      key="breakdown"
      data={data}
      onNext={handleNext}
      onBack={handleBack}
      initialBreakdown={initialBreakdown}
      initialStatus={initialBreakdownStatus}
    />,
    <GitHubStep
      key="github"
      data={data}
      onChange={setData}
      onNext={handleNext}
      onBack={handleBack}
    />,
    <JiraStep
      key="jira"
      data={data}
      onChange={setData}
      onNext={handleNext}
      onBack={handleBack}
    />,
    <ScaffoldStep
      key="scaffold"
      data={data}
      onNext={handleNext}
      onBack={handleBack}
    />,
    <LyraTeamStep
      key="team-setup"
      data={data}
      onNext={handleNext}
      onBack={handleBack}
    />,
    <ReviewExecuteStep
      key="review"
      data={data}
      onBack={handleBack}
    />,
  ];

  // Component order must match step order:
  // Existing codebase: Vision(0) → GitHub(3) → Analysis → Architect(1) → Breakdown(2) → Jira(4) → Scaffold(5) → Team(6) → Review(7)
  // New project:       Vision(0) → Architect(1) → Breakdown(2) → GitHub(3) → Jira(4) → Scaffold(5) → Team(6) → Review(7)
  const stepComponents = showAnalysis
    ? [
        baseComponents[0],  // Vision
        baseComponents[3],  // GitHub (moved before Analysis)
        <CodebaseAnalysisStep
          key="analysis"
          data={data}
          onNext={handleNext}
          onBack={handleBack}
        />,
        baseComponents[1],  // Architect
        baseComponents[2],  // Breakdown
        ...baseComponents.slice(4), // Jira, Scaffold, Team, Review
      ]
    : baseComponents;

  const totalSteps = steps.length;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Onboard New Project</h1>
        <p className="mt-1 text-gray-400">
          {resumingProjectId
            ? `Resuming: ${data.projectName || "Untitled"} (${data.jiraKey})`
            : `Set up a new project for AI-driven development in ${totalSteps - 1} steps.`}
        </p>
      </div>

      {sessionCost > 0 && (
        <div className="flex justify-end">
          <span className="text-xs text-gray-500">
            Session cost: <span className="text-gray-400 font-mono">${sessionCost.toFixed(4)}</span>
          </span>
        </div>
      )}

      <StepProgress
        steps={steps}
        currentStep={currentStep}
        statuses={stepStatuses}
        onStepClick={handleStepClick}
      />

      <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
        {stepComponents[currentStep]}
      </div>
    </div>
  );
}
