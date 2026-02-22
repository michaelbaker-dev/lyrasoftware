import { prisma } from "@/lib/db";
import OnboardingWizard from "./onboarding-wizard";
import type { OnboardingData } from "./onboarding-wizard";
import Link from "next/link";

type SearchParams = Promise<{ projectId?: string; new?: string }>;

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;

  // Force new project
  if (params.new === "true") {
    return <OnboardingWizard {...freshWizardProps()} />;
  }

  // Resume specific project
  if (params.projectId) {
    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
    });
    if (project && project.status === "onboarding") {
      return <OnboardingWizard {...buildWizardProps(project)} />;
    }
    // Project not found or not onboarding — fall through to picker/fresh
  }

  // Find all in-progress onboarding projects
  const onboardingProjects = await prisma.project.findMany({
    where: { status: "onboarding" },
    orderBy: { updatedAt: "desc" },
  });

  // No in-progress projects — start fresh
  if (onboardingProjects.length === 0) {
    return <OnboardingWizard {...freshWizardProps()} />;
  }

  // Single in-progress project — resume it
  if (onboardingProjects.length === 1) {
    return <OnboardingWizard {...buildWizardProps(onboardingProjects[0])} />;
  }

  // Multiple in-progress projects — show picker
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Onboard New Project</h1>
        <p className="mt-1 text-gray-400">
          You have multiple projects in progress. Choose one to resume, or start
          a new project.
        </p>
      </div>

      <div className="space-y-3">
        {onboardingProjects.map((p) => (
          <Link
            key={p.id}
            href={`/onboarding?projectId=${p.id}`}
            className="block rounded-lg border border-gray-700 bg-gray-800 p-4 hover:border-blue-500 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <p className="font-semibold text-gray-100">{p.name}</p>
                <p className="text-sm text-gray-400">
                  {p.jiraKey} &middot; Step {p.onboardingStep + 1}
                </p>
              </div>
              <p className="text-xs text-gray-500">
                {p.updatedAt.toLocaleDateString()}
              </p>
            </div>
          </Link>
        ))}
      </div>

      <Link
        href="/onboarding?new=true"
        className="inline-block px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
      >
        Start New Project
      </Link>
    </div>
  );
}

function freshWizardProps() {
  const emptyData: OnboardingData = {
    projectName: "",
    localPath: "",
    jiraKey: "",
    vision: "",
    targetUsers: "",
    constraints: "",
    existingRepo: "",
    techStack: "",
    description: "",
    githubMode: "create",
    archProfile: "simple",
  };
  return {
    initialData: emptyData,
    initialStep: 0,
    initialStatuses: Array(8).fill("pending") as (
      | "pending"
      | "running"
      | "completed"
      | "failed"
    )[],
    resumingProjectId: null,
    hasExistingCodebase: false,
  };
}

function buildWizardProps(project: {
  id: string;
  name: string;
  path: string;
  jiraKey: string;
  vision: string | null;
  targetUsers: string | null;
  constraints: string | null;
  existingRepo: string | null;
  techStack: string | null;
  description: string | null;
  onboardingStep: number;
  prdContent: string | null;
  ardContent: string | null;
  prdStatus: string;
  breakdownContent: string | null;
  breakdownStatus: string;
  archProfile: string;
  codebaseAnalysis: string | null;
  aiCostTotal: number;
}) {
  const data: OnboardingData = {
    projectName: project.name,
    localPath: project.path,
    jiraKey: project.jiraKey,
    vision: project.vision || "",
    targetUsers: project.targetUsers || "",
    constraints: project.constraints || "",
    existingRepo: project.existingRepo || "",
    techStack: project.techStack || "",
    description: project.description || "",
    githubMode: project.existingRepo ? "existing" : "create",
    archProfile: (project.archProfile as "simple" | "complex") || "simple",
  };

  const hasExistingCodebase = Boolean(project.codebaseAnalysis || project.existingRepo);
  const stepCount = hasExistingCodebase ? 9 : 8;

  // Build statuses: steps before onboardingStep are "completed"
  const statuses: ("pending" | "running" | "completed" | "failed")[] =
    Array(stepCount).fill("pending");
  for (let i = 0; i < project.onboardingStep; i++) {
    statuses[i] = "completed";
  }

  return {
    initialData: data,
    initialStep: project.onboardingStep,
    initialStatuses: statuses,
    resumingProjectId: project.id,
    initialPrd: project.prdContent || undefined,
    initialArd: project.ardContent || undefined,
    initialPrdStatus: project.prdStatus,
    initialBreakdown: project.breakdownContent || undefined,
    initialBreakdownStatus: project.breakdownStatus,
    hasExistingCodebase,
    initialSessionCost: project.aiCostTotal,
  };
}
