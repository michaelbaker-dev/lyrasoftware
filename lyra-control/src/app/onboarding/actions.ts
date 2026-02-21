"use server";

import { prisma } from "@/lib/db";
import * as github from "@/lib/github";
import * as jira from "@/lib/jira";
import { chat } from "@/lib/openrouter";
import { isTavilyConfigured, searchWeb, formatSearchResultsForPrompt } from "@/lib/tavily";
import { renderAllTemplates } from "@/lib/templates";
import { analyzeCodebase, type CodebaseAnalysis } from "@/lib/codebase-analyzer";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { promisify } from "util";
import { execFile } from "child_process";

const exec = promisify(execFile);

export type StepResult = {
  success: boolean;
  logs: string[];
  error?: string;
};

export type ArchitectResult = StepResult & {
  prdContent?: string;
  ardContent?: string;
  techStack?: string;
  usedModel?: string;
  usedProvider?: string;
};

export type ExecuteResult = {
  success: boolean;
  steps: { name: string; status: "success" | "failed" | "skipped"; logs: string[] }[];
  error?: string;
};

// ── Step 1: Validate & Save Project (idempotent) ────────────────────

export async function validateProject(data: {
  projectName: string;
  localPath: string;
  jiraKey: string;
  vision: string;
  targetUsers?: string;
  constraints?: string;
  existingRepo?: string;
  archProfile?: "simple" | "complex";
}): Promise<StepResult> {
  const logs: string[] = [];

  try {
    // Validate project name
    if (!data.projectName || data.projectName.length < 2) {
      return { success: false, logs, error: "Project name must be at least 2 characters" };
    }
    logs.push(`Project name: ${data.projectName}`);

    // Validate local path exists
    const expandedPath = data.localPath.replace(/^~/, process.env.HOME || "");
    if (!existsSync(expandedPath)) {
      mkdirSync(expandedPath, { recursive: true });
      logs.push(`Created directory: ${expandedPath}`);
    } else {
      logs.push(`Path exists: ${expandedPath}`);
    }

    // Validate Jira key format
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(data.jiraKey)) {
      return {
        success: false,
        logs,
        error: "Jira key must be 2-10 uppercase letters/numbers, starting with a letter",
      };
    }

    // Derive description from first line of vision
    const description = data.vision.split("\n")[0].slice(0, 200);

    // Idempotent: if jiraKey exists with status "onboarding", update it
    const existing = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
    });

    if (existing) {
      if (existing.status !== "onboarding") {
        return { success: false, logs, error: `Jira key ${data.jiraKey} already in use by active project "${existing.name}"` };
      }
      // Update existing onboarding project
      const archProfile = data.archProfile || "simple";
      await prisma.project.update({
        where: { jiraKey: data.jiraKey },
        data: {
          name: data.projectName,
          path: expandedPath,
          githubRepo: data.projectName.toLowerCase().replace(/\s+/g, "-"),
          vision: data.vision,
          description,
          targetUsers: data.targetUsers || null,
          constraints: data.constraints || null,
          existingRepo: data.existingRepo || null,
          archProfile,
          baseBranch: archProfile === "complex" ? "develop" : "main",
          environments: archProfile === "complex"
            ? JSON.stringify([
                { name: "dev", port: 3000, branch: "develop" },
                { name: "qa", port: 3001, branch: "develop" },
                { name: "prod", port: 3002, branch: "main" },
              ])
            : null,
        },
      });
      logs.push(`Jira key ${data.jiraKey} — updated existing onboarding project`);
      logs.push(`Project updated in database (id: ${existing.id})`);

      await prisma.auditLog.create({
        data: {
          projectId: existing.id,
          action: "project.updated",
          actor: "user",
          details: JSON.stringify({ step: "validation", projectName: data.projectName, jiraKey: data.jiraKey }),
        },
      });

      return { success: true, logs };
    }

    logs.push(`Jira key ${data.jiraKey} is available`);

    // Create new project
    const newArchProfile = data.archProfile || "simple";
    const project = await prisma.project.create({
      data: {
        name: data.projectName,
        path: expandedPath,
        jiraKey: data.jiraKey,
        githubRepo: data.projectName.toLowerCase().replace(/\s+/g, "-"),
        vision: data.vision,
        description,
        targetUsers: data.targetUsers || null,
        constraints: data.constraints || null,
        existingRepo: data.existingRepo || null,
        status: "onboarding",
        archProfile: newArchProfile,
        baseBranch: newArchProfile === "complex" ? "develop" : "main",
        environments: newArchProfile === "complex"
          ? JSON.stringify([
              { name: "dev", port: 3000, branch: "develop" },
              { name: "qa", port: 3001, branch: "develop" },
              { name: "prod", port: 3002, branch: "main" },
            ])
          : null,
      },
    });
    logs.push(`Project saved to database (id: ${project.id})`);

    await prisma.auditLog.create({
      data: {
        projectId: project.id,
        action: "project.created",
        actor: "user",
        details: JSON.stringify({ step: "validation", projectName: data.projectName, jiraKey: data.jiraKey }),
      },
    });

    return { success: true, logs };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Save onboarding step position ───────────────────────────────────

export async function saveOnboardingStep(jiraKey: string, step: number): Promise<void> {
  await prisma.project.updateMany({
    where: { jiraKey },
    data: { onboardingStep: step },
  });
}

// ── Check Tavily configuration ──────────────────────────────────────

export async function checkTavilyConfigured(): Promise<boolean> {
  return isTavilyConfigured();
}

// ── Save GitHub config choice ───────────────────────────────────────

export async function saveGitHubConfig(
  jiraKey: string,
  mode: "create" | "existing",
  repoUrl?: string
): Promise<StepResult> {
  try {
    const updateData: Record<string, string | null> = {};
    if (mode === "existing" && repoUrl) {
      updateData.existingRepo = repoUrl;
    } else if (mode === "create") {
      updateData.existingRepo = null;
    }

    await prisma.project.updateMany({
      where: { jiraKey },
      data: updateData,
    });

    return { success: true, logs: [`GitHub mode saved: ${mode}`] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

// ── Codebase Analysis ───────────────────────────────────────────────

export type AnalysisResult = StepResult & {
  analysis?: CodebaseAnalysis;
};

export async function analyzeExistingCodebase(
  jiraKey: string,
  repoPath: string
): Promise<AnalysisResult> {
  const logs: string[] = [];

  try {
    const expandedPath = repoPath.replace(/^~/, process.env.HOME || "");

    await prisma.project.updateMany({
      where: { jiraKey },
      data: { analysisStatus: "analyzing" },
    });

    // If the local path is empty but an existing repo is linked, clone it first
    const project = await prisma.project.findUnique({
      where: { jiraKey },
      select: { existingRepo: true, id: true },
    });

    if (project?.existingRepo) {
      logs.push(`Checking local directory: ${expandedPath}`);
      const { cloneOrPull } = await import("@/lib/github");
      const cloneResult = await cloneOrPull(project.existingRepo, expandedPath, project.id);
      if (cloneResult.cloned) {
        logs.push(`Cloned ${project.existingRepo} into ${expandedPath}`);
      } else if (cloneResult.pulled) {
        logs.push("Pulled latest changes from remote");
      } else if (cloneResult.error) {
        logs.push(`WARNING: Could not clone/pull: ${cloneResult.error}`);
      }
    }

    logs.push(`Analyzing codebase at: ${expandedPath}`);

    const analysis = await analyzeCodebase(expandedPath);
    logs.push(`Detected framework: ${analysis.framework}`);
    logs.push(`Detected language: ${analysis.language}`);
    logs.push(`Package manager: ${analysis.packageManager}`);
    logs.push(`Key dependencies: ${analysis.keyDependencies.length}`);
    if (analysis.testFramework) logs.push(`Test framework: ${analysis.testFramework}`);
    if (analysis.ciConfig) logs.push(`CI workflows: ${analysis.ciConfig}`);

    await prisma.project.updateMany({
      where: { jiraKey },
      data: {
        codebaseAnalysis: JSON.stringify(analysis),
        analysisStatus: "complete",
      },
    });
    logs.push("Analysis saved to database");

    await prisma.auditLog.create({
      data: {
        action: "codebase.analyzed",
        actor: "system",
        details: JSON.stringify({
          jiraKey,
          framework: analysis.framework,
          language: analysis.language,
        }),
      },
    });

    return { success: true, logs, analysis };
  } catch (e) {
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { analysisStatus: "failed" },
    });
    return { success: false, logs, error: (e as Error).message };
  }
}

export async function getCodebaseAnalysis(jiraKey: string): Promise<CodebaseAnalysis | null> {
  const project = await prisma.project.findUnique({
    where: { jiraKey },
    select: { codebaseAnalysis: true },
  });
  if (!project?.codebaseAnalysis) return null;
  return JSON.parse(project.codebaseAnalysis) as CodebaseAnalysis;
}

// ── LLM-powered analysis summary ────────────────────────────────────

const ANALYSIS_SUMMARY_PROMPT = `You are an expert software architect reviewing an existing codebase. Based on the deep codebase analysis provided, produce a concise architectural summary that covers:

1. **What this project is** — infer the product/application purpose from the structure, dependencies, source code, and README
2. **Architecture patterns** — identify patterns (MVC, microservices, monolith, serverless, etc.) based on actual source structure and code excerpts
3. **API surface area** — assess the API routes, RESTful design, and endpoint organization
4. **Data layer** — ORM patterns, database models, and data access patterns
5. **Frontend organization** — component hierarchy, state management approach, page structure
6. **Security posture** — auth implementation, environment variable handling, security patterns
7. **Current state assessment** — maturity level, test coverage posture, CI/CD setup, code statistics
8. **Key observations** — anything notable about the codebase structure, dependency choices, or potential concerns
9. **Recommended focus areas** — what to prioritize for the next phase of development

Be specific and actionable. Reference actual source files, API routes, components, and database models from the analysis. Keep it under 800 words.`;

export type SummaryResult = StepResult & {
  summary?: string;
  usedModel?: string;
  stats?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    durationMs: number;
    tokensPerSecond: number;
    provider: string;
  };
};

export async function generateAnalysisSummary(data: {
  jiraKey: string;
  model: string;
}): Promise<SummaryResult> {
  const logs: string[] = [];

  try {
    const project = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
      select: { codebaseAnalysis: true, name: true },
    });

    if (!project?.codebaseAnalysis) {
      return { success: false, logs, error: "No codebase analysis found. Run filesystem analysis first." };
    }

    const analysis = JSON.parse(project.codebaseAnalysis) as CodebaseAnalysis;

    const codeStats = analysis.codeStats;
    const extBreakdown = Object.entries(codeStats.byExtension)
      .sort(([, a], [, b]) => b.lines - a.lines)
      .slice(0, 10)
      .map(([ext, s]) => `  ${ext}: ${s.files} files, ${s.lines.toLocaleString()} lines`)
      .join("\n");

    const userPrompt = `Project: ${project.name}

Filesystem Analysis Results:
- Framework: ${analysis.framework}
- Language: ${analysis.language}
- Package Manager: ${analysis.packageManager}
- Key Dependencies: ${analysis.keyDependencies.join(", ")}
- Dev Dependencies: ${analysis.devDependencies.join(", ")}
- Test Framework: ${analysis.testFramework || "None detected"}
- Test Pattern: ${analysis.testPattern || "N/A"}
- CI Workflows: ${analysis.ciConfig || "None detected"}
- Build Output: ${analysis.buildOutput || "None detected"}
- Entry Points: ${analysis.entryPoints.join(", ") || "None detected"}
- State Management: ${analysis.stateManagement || "None detected"}
- Auth Pattern: ${analysis.authPattern || "None detected"}
- Monorepo: ${analysis.monorepoType || "No (single project)"}

Code Statistics:
  Total: ${codeStats.totalFiles} source files, ${codeStats.totalLines.toLocaleString()} lines
${extBreakdown}

${analysis.apiRoutes.length > 0 ? `API Routes (${analysis.apiRoutes.length}):\n${analysis.apiRoutes.slice(0, 30).map((r) => `  ${r}`).join("\n")}` : "No API routes detected."}

${analysis.components.length > 0 ? `Components/Pages (${analysis.components.length}):\n${analysis.components.slice(0, 30).map((c) => `  ${c}`).join("\n")}` : "No components detected."}

${analysis.dbModels.length > 0 ? `Database Models (${analysis.dbModels.length}):\n${analysis.dbModels.map((m) => `  ${m}`).join("\n")}` : "No database models detected."}

${analysis.envVars.length > 0 ? `Environment Variables: ${analysis.envVars.join(", ")}` : "No env vars detected."}

${Object.keys(analysis.configSummary).length > 0 ? `Config Summary:\n${Object.entries(analysis.configSummary).map(([k, v]) => `  ${k}: ${v}`).join("\n")}` : ""}

Scripts:
${Object.entries(analysis.scripts).map(([k, v]) => `  ${k}: ${v}`).join("\n")}

Directory Structure:
${analysis.directoryOverview}

${analysis.existingDocs ? `README (excerpt):\n${analysis.existingDocs.slice(0, 1000)}` : "No README found."}

${analysis.existingAiConfig ? `Existing AI Config:\n${analysis.existingAiConfig.slice(0, 500)}` : ""}

${analysis.docFiles && Object.keys(analysis.docFiles).length > 0 ? `Documentation Files:\n${Object.entries(analysis.docFiles).map(([path, content]) => `--- ${path} ---\n${content.slice(0, 2000)}`).join("\n\n")}` : ""}

${Object.keys(analysis.sourceExcerpts).length > 0 ? `Source Excerpts (key files):\n${Object.entries(analysis.sourceExcerpts).slice(0, 5).map(([path, content]) => `--- ${path} ---\n${content.slice(0, 1500)}`).join("\n\n")}` : ""}`;

    logs.push(`Generating AI summary with model: ${data.model}...`);

    const result = await callAI(
      ANALYSIS_SUMMARY_PROMPT,
      [{ role: "user", content: userPrompt }],
      data.model
    );

    if (!result.content.trim()) {
      return { success: false, logs, error: "Empty response from AI provider" };
    }

    logs.push(`Response from: ${result.usedModel}`);
    logs.push(`Tokens: ${result.promptTokens} in / ${result.completionTokens} out (${result.tokensPerSecond} tok/s)`);
    if (result.cost > 0) logs.push(`Cost: $${result.cost.toFixed(4)}`);

    // Update analysis with AI summary
    analysis.aiSummary = result.content.trim();
    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { codebaseAnalysis: JSON.stringify(analysis) },
    });
    logs.push("AI summary saved to analysis");

    // Save usage metrics
    await saveAiUsage(data.jiraKey, "analysis", data.model, result);

    const stats = {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      cost: result.cost,
      durationMs: result.durationMs,
      tokensPerSecond: result.tokensPerSecond,
      provider: result.provider,
    };

    return {
      success: true,
      logs,
      summary: analysis.aiSummary,
      usedModel: result.usedModel,
      stats,
    };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Save per-project GitHub token ────────────────────────────────────

export async function saveProjectGitHubToken(
  jiraKey: string,
  token: string
): Promise<StepResult> {
  try {
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { githubToken: token },
    });
    return { success: true, logs: ["GitHub token saved for project"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

// ── Save Jira description ───────────────────────────────────────────

export async function saveJiraDescription(
  jiraKey: string,
  description: string
): Promise<StepResult> {
  try {
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { description },
    });
    return { success: true, logs: ["Description saved"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

// ── AI-Assisted Vision Generation ────────────────────────────────────

const VISION_SYSTEM_PROMPT = `You are a product strategist helping a user articulate their product vision. The user has typed rough notes, keywords, or bullet points describing what they want to build. Your job is to expand these into a clear, detailed product vision statement.

Return a well-structured vision document that covers:
- What the product is and what it does
- The problem it solves
- Who the target users are
- Core capabilities and key differentiators
- What success looks like

Keep the tone professional but accessible. Be specific and actionable — avoid generic platitudes. If the user's notes mention specific technologies, constraints, or preferences, incorporate those naturally.

Return plain text (not markdown headers) — this will be used as input for PRD generation. Aim for 200-400 words.`;

export async function generateVision(data: {
  projectName: string;
  jiraKey: string;
  roughInput: string;
  targetUsers?: string;
  constraints?: string;
  existingRepo?: string;
  previousContent?: string;
  feedback?: string;
  model: string;
  useWebSearch?: boolean;
}): Promise<DocResult> {
  const logs: string[] = [];

  try {
    let userPrompt = [
      `Project Name: ${data.projectName}`,
      `\nRough Notes / Keywords:\n${data.roughInput}`,
      data.targetUsers ? `\nTarget Users: ${data.targetUsers}` : "",
      data.constraints ? `\nConstraints & Preferences:\n${data.constraints}` : "",
      data.existingRepo ? `\nExisting Codebase: ${data.existingRepo}` : "",
    ].filter(Boolean).join("\n");

    // Optionally enrich with web research
    let searchStats: SearchStats | null = null;
    let aiModel = data.model;

    if (data.useWebSearch) {
      const searchQuery = `${data.projectName} ${data.roughInput.slice(0, 100)}`;
      const ws = await withWebSearch({
        model: data.model,
        query: searchQuery,
        jiraKey: data.jiraKey,
        category: "vision",
      });
      aiModel = ws.model;
      searchStats = ws.searchStats;
      if (ws.promptSuffix) {
        userPrompt += ws.promptSuffix;
      }
      if (ws.searchStats) {
        logs.push(`Enriched with web research via ${ws.searchStats.provider === "openrouter" ? "OpenRouter :online" : "Tavily"}`);
      }
    }

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "user", content: userPrompt },
    ];

    if (data.previousContent && data.feedback) {
      messages.push({ role: "assistant", content: data.previousContent });
      messages.push({ role: "user", content: `Please revise the vision based on this feedback:\n\n${data.feedback}\n\nReturn the complete revised vision.` });
      logs.push("Regenerating vision with feedback...");
    } else if (data.previousContent) {
      messages.push({ role: "assistant", content: data.previousContent });
      messages.push({ role: "user", content: "The user has edited the vision above. Please review their edits and regenerate a clean, polished vision incorporating their changes." });
      logs.push("Regenerating vision from edits...");
    } else {
      logs.push("Generating vision...");
    }

    logs.push(`Requesting model: ${aiModel}`);
    const result = await callAI(VISION_SYSTEM_PROMPT, messages, aiModel);
    logs.push(`Response from: ${result.usedModel}`);

    if (!result.content.trim()) {
      return { success: false, logs, error: "Empty response from AI provider" };
    }

    const content = result.content.trim();

    // Save usage metrics
    await saveAiUsage(data.jiraKey, "vision", data.model, result);
    logs.push(`Tokens: ${result.promptTokens} in / ${result.completionTokens} out (${result.tokensPerSecond} tok/s)`);
    if (result.cost > 0) logs.push(`Cost: $${result.cost.toFixed(4)}`);

    // For :online, estimate search cost and subtract from LLM cost
    let llmCost = result.cost;
    if (searchStats?.provider === "openrouter" && result.cost > OPENROUTER_SEARCH_COST) {
      llmCost = result.cost - OPENROUTER_SEARCH_COST;
    }

    const stats = {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      cost: searchStats ? llmCost : result.cost,
      durationMs: result.durationMs,
      tokensPerSecond: result.tokensPerSecond,
      provider: result.provider,
      searchStats: searchStats || undefined,
    };

    return { success: true, logs, content, usedModel: result.usedModel, stats };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Step 2: Architect — Generate PRD, then ARD separately ───────────

const PRD_SYSTEM_PROMPT = `You are the Architect agent for Lyra, an AI-driven development platform. Your job is to generate a PRD (Product Requirements Document) based on the user's product vision.

Return a single markdown document with these sections:
# PRD: {Project Name}
## Vision
## Target Users
## Core Features (numbered list)
## Requirements
### Functional Requirements
### Non-Functional Requirements
## Success Criteria
## Out of Scope (v1)

Be thorough but concise. Focus on actionable requirements.`;

const ARD_SYSTEM_PROMPT = `You are the Architect agent for Lyra, an AI-driven development platform. Your job is to generate an ARD (Architecture Decision Record) based on an approved PRD.

Return a single markdown document with these sections:
# ARD: {Project Name}
## Context
## Decision
## Tech Stack

The Tech Stack section MUST contain a markdown table with columns: Category | Choice | Rationale
Example:
| Category | Choice | Rationale |
|----------|--------|-----------|
| Language | TypeScript | Type safety, ecosystem |
| Framework | Next.js 15 | App Router, RSC, Vercel deploy |
| Database | PostgreSQL | Relational data, mature |

## Architecture Overview
## Key Decisions
## Consequences

Base all decisions on the PRD provided. Be specific about technology choices.`;

// ── Model catalog for OpenRouter ────────────────────────────────────

import { CLOUD_MODELS, matchLocalModel } from "./models";
import { getBaseUrl as getJiraBaseUrl } from "@/lib/jira";

const LM_STUDIO_URL_DEFAULT = "http://192.168.56.203:1234";

async function getLmStudioUrl(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "lm_studio_url" },
  });
  return setting?.value || LM_STUDIO_URL_DEFAULT;
}

type AiCallResult = {
  content: string;
  usedModel: string;
  provider: "openrouter" | "lmstudio";
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;           // USD, 0 for local
  durationMs: number;
  tokensPerSecond: number;
};

async function callOpenRouter(
  systemPrompt: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  model: string
): Promise<AiCallResult> {
  const start = Date.now();
  const response = await chat(
    [{ role: "system", content: systemPrompt }, ...messages],
    model
  );
  const durationMs = Date.now() - start;
  const completionTokens = response.usage?.completion_tokens || 0;
  const tokensPerSecond = durationMs > 0 ? (completionTokens / (durationMs / 1000)) : 0;

  return {
    content: response.choices[0]?.message?.content || "",
    usedModel: response.model || model,
    provider: "openrouter",
    promptTokens: response.usage?.prompt_tokens || 0,
    completionTokens,
    totalTokens: response.usage?.total_tokens || 0,
    cost: response.usage?.cost || 0,
    durationMs,
    tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
  };
}

async function callLmStudio(
  systemPrompt: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  model: string
): Promise<AiCallResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 600_000); // 10 min timeout for large models

  try {
    const lmStudioUrl = await getLmStudioUrl();
    const start = Date.now();
    const response = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
        temperature: 0.7,
        max_tokens: 8192,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LM Studio error ${response.status}: ${body}`);
    }

    const data = await response.json();
    const durationMs = Date.now() - start;
    const completionTokens = data.usage?.completion_tokens || 0;
    const tokensPerSecond = durationMs > 0 ? (completionTokens / (durationMs / 1000)) : 0;

    return {
      content: data.choices?.[0]?.message?.content || "",
      usedModel: `${data.model || model} (LM Studio)`,
      provider: "lmstudio",
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens,
      totalTokens: data.usage?.total_tokens || 0,
      cost: 0, // local is free
      durationMs,
      tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
    };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      throw new Error("LM Studio request timed out after 10 minutes. Try a smaller model.");
    }
    throw e;
  } finally {
    clearTimeout(timeout);
  }
}

// Route to correct provider based on model ID prefix
async function callAI(
  systemPrompt: string,
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  model: string
): Promise<AiCallResult> {
  if (model.startsWith("local:")) {
    const localModelId = model.slice("local:".length);
    return callLmStudio(systemPrompt, messages, localModelId);
  }
  return callOpenRouter(systemPrompt, messages, model);
}

// Save AI usage metrics to DB
/** Strip the "> Generated by: ..." header block we prepend to docs */
function stripDocHeader(content: string): string {
  return content.replace(/^(?:>.*\n)+\n?/, "").trim();
}

async function saveAiUsage(
  jiraKey: string,
  document: string,
  requestedModel: string,
  result: AiCallResult
): Promise<void> {
  const project = await prisma.project.findUnique({ where: { jiraKey } });
  if (!project) return;

  await prisma.aiUsageLog.create({
    data: {
      projectId: project.id,
      document,
      provider: result.provider,
      requestedModel,
      actualModel: result.usedModel,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      cost: result.cost,
      durationMs: result.durationMs,
      tokensPerSecond: result.tokensPerSecond,
    },
  });

  // Update project total cost
  if (result.cost > 0) {
    await prisma.project.update({
      where: { id: project.id },
      data: { aiCostTotal: { increment: result.cost } },
    });
  }
}

// ── Web Search Provider Selection ─────────────────────────────────────

const OPENROUTER_SEARCH_COST = 0.02; // ~$4/1000 searches × 5 results
const TAVILY_BASIC_COST = 0.01;

type WebSearchResult = {
  model: string;           // possibly with :online appended
  promptSuffix: string;    // "" for :online, formatted results for tavily
  searchStats: SearchStats | null;
};

async function withWebSearch(opts: {
  model: string;
  query: string;
  jiraKey: string;
  category: string;
}): Promise<WebSearchResult> {
  const isLocal = opts.model.startsWith("local:");

  if (isLocal) {
    // Local models use Tavily
    if (!(await isTavilyConfigured())) {
      return { model: opts.model, promptSuffix: "", searchStats: null };
    }
    const project = await prisma.project.findUnique({
      where: { jiraKey: opts.jiraKey },
      select: { id: true },
    });
    const webResults = await searchWeb(opts.query, {
      maxResults: 5,
      searchDepth: "basic",
      projectId: project?.id,
      category: opts.category,
    });
    return {
      model: opts.model,
      promptSuffix: "\n\n" + formatSearchResultsForPrompt(webResults),
      searchStats: {
        provider: "tavily",
        cost: TAVILY_BASIC_COST,
        durationMs: webResults.searchDurationMs,
        resultCount: webResults.results.length,
      },
    };
  }

  // Cloud models use OpenRouter :online suffix
  return {
    model: opts.model + ":online",
    promptSuffix: "",
    searchStats: {
      provider: "openrouter",
      cost: OPENROUTER_SEARCH_COST,
      durationMs: 0, // included in LLM call duration
      resultCount: 5, // OpenRouter returns ~5 results
    },
  };
}

// ── Fetch available models from LM Studio ────────────────────────────

export async function fetchLocalModels(): Promise<{
  success: boolean;
  models: { id: string; label: string; parameterSize: string; capability: string; description: string }[];
  error?: string;
}> {
  try {
    const lmStudioUrl = await getLmStudioUrl();
    const response = await fetch(`${lmStudioUrl}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return { success: false, models: [], error: `LM Studio returned ${response.status}` };
    }
    const data = await response.json();
    const models = (data.data || [])
      .map((m: { id: string }) => m.id)
      .filter((id: string) => !id.includes("embedding") && !id.includes("nomic"))
      .map((id: string) => {
        const info = matchLocalModel(id);
        return {
          id: info.id,
          label: info.label,
          parameterSize: info.parameterSize,
          capability: info.capability,
          description: info.description,
        };
      })
      .sort((a: { capability: string }, b: { capability: string }) => {
        const order = { excellent: 0, strong: 1, good: 2, basic: 3 };
        return (order[a.capability as keyof typeof order] ?? 2) - (order[b.capability as keyof typeof order] ?? 2);
      });
    return { success: true, models };
  } catch (e) {
    return { success: false, models: [], error: (e as Error).message };
  }
}

function extractTechStack(ardContent: string): string {
  const lines = ardContent.split("\n");
  const techItems: string[] = [];
  let inTable = false;

  for (const line of lines) {
    if (line.includes("| Category") && line.includes("| Choice")) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith("|---")) continue;
    if (inTable && line.startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter(Boolean);
      if (cells.length >= 2) {
        techItems.push(cells[1]);
      }
    } else if (inTable) {
      break;
    }
  }

  return techItems.join(", ") || "Not specified";
}

// ── Generate PRD only ───────────────────────────────────────────────

export type SearchStats = {
  provider: "tavily" | "openrouter";
  cost: number;
  durationMs: number;
  resultCount: number;
};

export type DocResult = StepResult & {
  content?: string;
  usedModel?: string;
  techStack?: string;
  stats?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    durationMs: number;
    tokensPerSecond: number;
    provider: string;
    searchStats?: SearchStats;
  };
};

export async function generatePrd(data: {
  projectName: string;
  jiraKey: string;
  vision: string;
  targetUsers?: string;
  constraints?: string;
  existingRepo?: string;
  previousContent?: string;
  feedback?: string;
  model: string;
  useWebSearch?: boolean;
}): Promise<DocResult> {
  const logs: string[] = [];

  try {
    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { prdStatus: "generating" },
    });

    // Check for codebase analysis
    const project = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
      select: { codebaseAnalysis: true },
    });
    const analysisJson = project?.codebaseAnalysis;
    let analysisContext = "";
    if (analysisJson) {
      const analysis = JSON.parse(analysisJson) as CodebaseAnalysis;
      analysisContext = `\n\nThis is an EXISTING codebase with the following analysis:
- Framework: ${analysis.framework}
- Language: ${analysis.language}
- Package Manager: ${analysis.packageManager}
- Key Dependencies: ${analysis.keyDependencies.join(", ")}
- Test Framework: ${analysis.testFramework || "None detected"}
- Entry Points: ${analysis.entryPoints.join(", ") || "Not detected"}
${analysis.existingDocs ? `\nExisting README (excerpt):\n${analysis.existingDocs.slice(0, 500)}` : ""}

The PRD should describe the current product state AND planned enhancements. Do not describe features that already exist as new requirements — instead reference them as existing functionality to build upon.`;
    }

    let userPrompt = [
      `Project Name: ${data.projectName}`,
      `Jira Key: ${data.jiraKey}`,
      `\nProduct Vision:\n${data.vision}`,
      data.targetUsers ? `\nTarget Users: ${data.targetUsers}` : "",
      data.constraints ? `\nConstraints & Preferences:\n${data.constraints}` : "",
      data.existingRepo ? `\nExisting Codebase: ${data.existingRepo}` : "",
      analysisContext,
    ].filter(Boolean).join("\n");

    // Optionally enrich with web research
    let prdSearchStats: SearchStats | null = null;
    let prdAiModel = data.model;

    if (data.useWebSearch) {
      const searchQuery = `${data.projectName} ${data.vision?.slice(0, 100)}`;
      const ws = await withWebSearch({
        model: data.model,
        query: searchQuery,
        jiraKey: data.jiraKey,
        category: "prd",
      });
      prdAiModel = ws.model;
      prdSearchStats = ws.searchStats;
      if (ws.promptSuffix) {
        userPrompt += ws.promptSuffix;
      }
      if (ws.searchStats) {
        logs.push(`Enriched with web research via ${ws.searchStats.provider === "openrouter" ? "OpenRouter :online" : "Tavily"}`);
      }
    }

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "user", content: userPrompt },
    ];

    if (data.previousContent && data.feedback) {
      messages.push({ role: "assistant", content: stripDocHeader(data.previousContent) });
      messages.push({ role: "user", content: `Please revise the PRD based on this feedback:\n\n${data.feedback}\n\nReturn the complete revised PRD.` });
      logs.push("Regenerating PRD with feedback...");
    } else if (data.previousContent) {
      messages.push({ role: "assistant", content: stripDocHeader(data.previousContent) });
      messages.push({ role: "user", content: "The user has edited the PRD above. Please review their edits and regenerate a clean, complete PRD incorporating their changes." });
      logs.push("Regenerating PRD from edits...");
    } else {
      logs.push("Generating PRD...");
    }

    logs.push(`Requesting model: ${prdAiModel}`);
    const result = await callAI(PRD_SYSTEM_PROMPT, messages, prdAiModel);
    logs.push(`Response from: ${result.usedModel}`);

    if (!result.content.trim()) {
      await prisma.project.updateMany({
        where: { jiraKey: data.jiraKey },
        data: { prdStatus: "pending" },
      });
      return { success: false, logs, error: "Empty response from AI provider" };
    }

    const cleanContent = stripDocHeader(result.content.trim());
    const isLocal = data.model.startsWith("local:");
    const cloudInfo = CLOUD_MODELS.find(m => m.id === data.model);
    const modelLabel = cloudInfo?.label || (isLocal ? `Local: ${data.model.slice(6)}` : data.model);
    const providerTag = isLocal ? "LM Studio (local)" : "OpenRouter";
    const header = `> Generated by: **${result.usedModel}** via ${providerTag} (requested: ${modelLabel})  \n> Date: ${new Date().toISOString().split("T")[0]}\n\n`;
    const finalContent = header + cleanContent;

    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { prdContent: finalContent, prdStatus: "review" },
    });
    logs.push("PRD saved to database");

    // Save usage metrics
    await saveAiUsage(data.jiraKey, "prd", data.model, result);
    logs.push(`Tokens: ${result.promptTokens} in / ${result.completionTokens} out (${result.tokensPerSecond} tok/s)`);
    if (result.cost > 0) logs.push(`Cost: $${result.cost.toFixed(4)}`);

    await prisma.auditLog.create({
      data: {
        action: "prd.generated",
        actor: "system",
        details: JSON.stringify({ jiraKey: data.jiraKey, requestedModel: data.model, actualModel: result.usedModel }),
      },
    });

    // For :online, estimate search cost and subtract from LLM cost
    let prdLlmCost = result.cost;
    if (prdSearchStats?.provider === "openrouter" && result.cost > OPENROUTER_SEARCH_COST) {
      prdLlmCost = result.cost - OPENROUTER_SEARCH_COST;
    }

    const stats = {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      cost: prdSearchStats ? prdLlmCost : result.cost,
      durationMs: result.durationMs,
      tokensPerSecond: result.tokensPerSecond,
      provider: result.provider,
      searchStats: prdSearchStats || undefined,
    };

    return { success: true, logs, content: finalContent, usedModel: result.usedModel, stats };
  } catch (e) {
    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { prdStatus: data.previousContent ? "review" : "pending" },
    });
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Generate ARD only (requires approved PRD) ───────────────────────

export async function generateArd(data: {
  projectName: string;
  jiraKey: string;
  prdContent: string;
  previousContent?: string;
  feedback?: string;
  model: string;
  useWebSearch?: boolean;
}): Promise<DocResult> {
  const logs: string[] = [];

  try {
    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { ardStatus: "generating" },
    });

    // Check for codebase analysis
    const ardProject = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
      select: { codebaseAnalysis: true },
    });
    const ardAnalysisJson = ardProject?.codebaseAnalysis;
    let ardAnalysisContext = "";
    if (ardAnalysisJson) {
      const analysis = JSON.parse(ardAnalysisJson) as CodebaseAnalysis;
      ardAnalysisContext = `\n\nThis codebase already uses the following stack:
- Framework: ${analysis.framework}
- Language: ${analysis.language}
- Key Dependencies: ${analysis.keyDependencies.join(", ")}
- Dev Dependencies: ${analysis.devDependencies.join(", ")}
- Test Framework: ${analysis.testFramework || "None"}
- Build Output: ${analysis.buildOutput || "None detected"}
- CI: ${analysis.ciConfig || "None detected"}

The ARD should document existing architecture decisions AND planned additions. Do not recommend replacing working technology choices unless there is a compelling reason.`;
    }

    let ardUserContent = `Project Name: ${data.projectName}\n\nApproved PRD:\n${data.prdContent}${ardAnalysisContext}`;

    // Optionally enrich with web research
    let ardSearchStats: SearchStats | null = null;
    let ardAiModel = data.model;

    if (data.useWebSearch) {
      const searchQuery = `${data.projectName} architecture best practices ${data.prdContent?.slice(0, 80)}`;
      const ws = await withWebSearch({
        model: data.model,
        query: searchQuery,
        jiraKey: data.jiraKey,
        category: "ard",
      });
      ardAiModel = ws.model;
      ardSearchStats = ws.searchStats;
      if (ws.promptSuffix) {
        ardUserContent += ws.promptSuffix;
      }
      if (ws.searchStats) {
        logs.push(`Enriched with web research via ${ws.searchStats.provider === "openrouter" ? "OpenRouter :online" : "Tavily"}`);
      }
    }

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "user", content: ardUserContent },
    ];

    if (data.previousContent && data.feedback) {
      messages.push({ role: "assistant", content: stripDocHeader(data.previousContent) });
      messages.push({ role: "user", content: `Please revise the ARD based on this feedback:\n\n${data.feedback}\n\nReturn the complete revised ARD.` });
      logs.push("Regenerating ARD with feedback...");
    } else if (data.previousContent) {
      messages.push({ role: "assistant", content: stripDocHeader(data.previousContent) });
      messages.push({ role: "user", content: "The user has edited the ARD above. Please review their edits and regenerate a clean, complete ARD incorporating their changes." });
      logs.push("Regenerating ARD from edits...");
    } else {
      logs.push("Generating ARD...");
    }

    logs.push(`Requesting model: ${ardAiModel}`);
    const result = await callAI(ARD_SYSTEM_PROMPT, messages, ardAiModel);
    logs.push(`Response from: ${result.usedModel}`);

    if (!result.content.trim()) {
      await prisma.project.updateMany({
        where: { jiraKey: data.jiraKey },
        data: { ardStatus: "pending" },
      });
      return { success: false, logs, error: "Empty response from AI provider" };
    }

    const cleanContent = stripDocHeader(result.content.trim());
    const techStack = extractTechStack(cleanContent);
    logs.push(`Tech stack: ${techStack}`);

    const isLocal = data.model.startsWith("local:");
    const cloudInfo = CLOUD_MODELS.find(m => m.id === data.model);
    const modelLabel = cloudInfo?.label || (isLocal ? `Local: ${data.model.slice(6)}` : data.model);
    const providerTag = isLocal ? "LM Studio (local)" : "OpenRouter";
    const header = `> Generated by: **${result.usedModel}** via ${providerTag} (requested: ${modelLabel})  \n> Date: ${new Date().toISOString().split("T")[0]}\n\n`;
    const finalContent = header + cleanContent;

    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: {
        ardContent: finalContent,
        techStack,
        ardStatus: "review",
      },
    });
    logs.push("ARD saved to database");

    // Save usage metrics
    await saveAiUsage(data.jiraKey, "ard", data.model, result);
    logs.push(`Tokens: ${result.promptTokens} in / ${result.completionTokens} out (${result.tokensPerSecond} tok/s)`);
    if (result.cost > 0) logs.push(`Cost: $${result.cost.toFixed(4)}`);

    await prisma.auditLog.create({
      data: {
        action: "ard.generated",
        actor: "system",
        details: JSON.stringify({ jiraKey: data.jiraKey, requestedModel: data.model, actualModel: result.usedModel }),
      },
    });

    // For :online, estimate search cost and subtract from LLM cost
    let ardLlmCost = result.cost;
    if (ardSearchStats?.provider === "openrouter" && result.cost > OPENROUTER_SEARCH_COST) {
      ardLlmCost = result.cost - OPENROUTER_SEARCH_COST;
    }

    const stats = {
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      totalTokens: result.totalTokens,
      cost: ardSearchStats ? ardLlmCost : result.cost,
      durationMs: result.durationMs,
      tokensPerSecond: result.tokensPerSecond,
      provider: result.provider,
      searchStats: ardSearchStats || undefined,
    };

    return { success: true, logs, content: finalContent, usedModel: result.usedModel, techStack, stats };
  } catch (e) {
    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { ardStatus: data.previousContent ? "review" : "pending" },
    });
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Approve PRD or ARD individually ─────────────────────────────────

export async function approvePrd(jiraKey: string): Promise<StepResult> {
  try {
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { prdStatus: "approved" },
    });
    await prisma.auditLog.create({
      data: { action: "prd.approved", actor: "user", details: JSON.stringify({ jiraKey }) },
    });
    return { success: true, logs: ["PRD approved"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

export async function approveArd(jiraKey: string): Promise<StepResult> {
  try {
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { ardStatus: "approved" },
    });
    await prisma.auditLog.create({
      data: { action: "ard.approved", actor: "user", details: JSON.stringify({ jiraKey }) },
    });
    return { success: true, logs: ["ARD approved"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

// ── Save edited document content ────────────────────────────────────

export async function savePrdContent(jiraKey: string, content: string): Promise<StepResult> {
  try {
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { prdContent: content, prdStatus: "review" },
    });
    return { success: true, logs: ["PRD saved"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

export async function saveArdContent(jiraKey: string, content: string): Promise<StepResult> {
  try {
    const techStack = extractTechStack(content);
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { ardContent: content, techStack, ardStatus: "review" },
    });
    return { success: true, logs: ["ARD saved"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

// ── Work Breakdown ──────────────────────────────────────────────────

import {
  generateWorkBreakdown as generateWB,
  createBreakdownInJira as createWBInJira,
  type WorkBreakdown,
} from "@/lib/work-breakdown";

export type BreakdownResult = StepResult & {
  content?: string;
  usedModel?: string;
  stats?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cost: number;
    durationMs: number;
    tokensPerSecond: number;
    provider: string;
  };
};

export async function generateBreakdown(data: {
  jiraKey: string;
  model: string;
  feedback?: string;
}): Promise<BreakdownResult> {
  const logs: string[] = [];

  try {
    const project = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
    });
    if (!project) {
      return { success: false, logs, error: "Project not found" };
    }
    if (!project.prdContent || !project.ardContent) {
      return { success: false, logs, error: "PRD and ARD must be approved before generating breakdown" };
    }

    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { breakdownStatus: "generating" },
    });

    // Build codebase context for existing projects
    let codebaseContext: string | null = null;
    if (project.codebaseAnalysis) {
      const analysis = JSON.parse(project.codebaseAnalysis) as CodebaseAnalysis;
      const parts: string[] = [];

      parts.push(`Framework: ${analysis.framework} | Language: ${analysis.language}`);
      parts.push(`Key Dependencies: ${analysis.keyDependencies.join(", ")}`);

      if (analysis.codeStats && analysis.codeStats.totalFiles > 0) {
        parts.push(`Codebase size: ${analysis.codeStats.totalFiles} source files, ${analysis.codeStats.totalLines.toLocaleString()} lines`);
      }

      if (analysis.apiRoutes && analysis.apiRoutes.length > 0) {
        parts.push(`\nExisting API Routes (${analysis.apiRoutes.length}):\n${analysis.apiRoutes.map((r) => `  ${r}`).join("\n")}`);
      }

      if (analysis.components && analysis.components.length > 0) {
        parts.push(`\nExisting Components/Pages (${analysis.components.length}):\n${analysis.components.slice(0, 50).map((c) => `  ${c}`).join("\n")}`);
      }

      if (analysis.dbModels && analysis.dbModels.length > 0) {
        parts.push(`\nExisting Database Models:\n${analysis.dbModels.map((m) => `  ${m}`).join("\n")}`);
      }

      if (analysis.stateManagement) parts.push(`State Management: ${analysis.stateManagement}`);
      if (analysis.authPattern) parts.push(`Auth: ${analysis.authPattern}`);
      if (analysis.testFramework) parts.push(`Test Framework: ${analysis.testFramework}`);

      if (analysis.entryPoints.length > 0) {
        parts.push(`Entry Points: ${analysis.entryPoints.join(", ")}`);
      }

      if (analysis.sourceExcerpts && Object.keys(analysis.sourceExcerpts).length > 0) {
        parts.push("\nKey Source Files:");
        for (const [path, content] of Object.entries(analysis.sourceExcerpts).slice(0, 5)) {
          parts.push(`--- ${path} ---\n${content.slice(0, 1000)}`);
        }
      }

      if (analysis.docFiles && Object.keys(analysis.docFiles).length > 0) {
        parts.push("\nDocumentation Files:");
        for (const [path, content] of Object.entries(analysis.docFiles).slice(0, 5)) {
          parts.push(`--- ${path} ---\n${content.slice(0, 1500)}`);
        }
      }

      if (analysis.aiSummary) {
        parts.push(`\nArchitectural Summary:\n${analysis.aiSummary}`);
      }

      codebaseContext = parts.join("\n");
      logs.push("Including existing codebase context in breakdown generation");
    }

    logs.push(`Generating work breakdown with model: ${data.model}...`);
    const start = Date.now();

    const { breakdown, rawResponse } = await generateWB(
      project.prdContent,
      project.ardContent,
      data.model,
      data.feedback,
      project.id,
      codebaseContext
    );

    const durationMs = Date.now() - start;
    logs.push(`Generated in ${Math.round(durationMs / 1000)}s`);

    const content = JSON.stringify(breakdown, null, 2);

    // Count totals
    let totalPoints = 0;
    let totalStories = 0;
    let totalEpics = 0;
    for (const feature of breakdown.features) {
      for (const epic of feature.epics) {
        totalEpics++;
        for (const story of epic.stories) {
          totalStories++;
          totalPoints += story.storyPoints;
        }
      }
    }

    logs.push(`Features: ${breakdown.features.length}, Epics: ${totalEpics}, Stories: ${totalStories}, Total Points: ${totalPoints}`);

    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { breakdownContent: content, breakdownStatus: "review" },
    });
    logs.push("Breakdown saved to database");

    await prisma.auditLog.create({
      data: {
        action: "breakdown.generated",
        actor: "system",
        details: JSON.stringify({
          jiraKey: data.jiraKey,
          model: data.model,
          features: breakdown.features.length,
          epics: totalEpics,
          stories: totalStories,
          points: totalPoints,
        }),
      },
    });

    return { success: true, logs, content, usedModel: data.model };
  } catch (e) {
    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { breakdownStatus: "pending" },
    });
    return { success: false, logs, error: (e as Error).message };
  }
}

export async function approveBreakdown(jiraKey: string): Promise<StepResult> {
  try {
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { breakdownStatus: "approved" },
    });
    await prisma.auditLog.create({
      data: { action: "breakdown.approved", actor: "user", details: JSON.stringify({ jiraKey }) },
    });
    return { success: true, logs: ["Work breakdown approved"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

export async function saveBreakdownContent(jiraKey: string, content: string): Promise<StepResult> {
  try {
    // Validate JSON
    JSON.parse(content);
    await prisma.project.updateMany({
      where: { jiraKey },
      data: { breakdownContent: content, breakdownStatus: "review" },
    });
    return { success: true, logs: ["Breakdown saved"] };
  } catch (e) {
    return { success: false, logs: [], error: (e as Error).message };
  }
}

// ── Internal: GitHub Setup ──────────────────────────────────────────

export async function setupGitHubInternal(data: {
  projectName: string;
  description: string;
}): Promise<StepResult> {
  const logs: string[] = [];
  const repoName = data.projectName.toLowerCase().replace(/\s+/g, "-");

  try {
    logs.push(`Creating GitHub repo: ${repoName}...`);
    await github.createRepo(repoName, data.description);
    logs.push(`Repository created: michaelbaker-dev/${repoName}`);

    logs.push("Setting branch protection on main...");
    await github.setBranchProtection(repoName, "main");
    logs.push("Branch protection configured for main");

    await prisma.project.updateMany({
      where: { githubRepo: repoName },
      data: { githubRepo: repoName },
    });

    await prisma.auditLog.create({
      data: {
        action: "github.repo_created",
        actor: "system",
        details: JSON.stringify({ repo: repoName }),
      },
    });

    return { success: true, logs };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

export async function useExistingGitHubInternal(data: {
  jiraKey: string;
  repoUrl: string;
}): Promise<StepResult> {
  const logs: string[] = [];

  try {
    const urlMatch = data.repoUrl.match(
      /(?:github\.com\/)?([^/]+)\/([^/.]+)/
    );
    if (!urlMatch) {
      return {
        success: false,
        logs,
        error: "Invalid repo URL. Expected format: https://github.com/org/repo or org/repo",
      };
    }
    const [, owner, repoName] = urlMatch;
    logs.push(`Parsed repo: ${owner}/${repoName}`);

    logs.push("Verifying repo exists...");
    try {
      await github.getRepoInfo(repoName);
      logs.push(`Repository verified: ${owner}/${repoName}`);
    } catch {
      return {
        success: false,
        logs,
        error: `Could not access repo ${owner}/${repoName}. Check that it exists and gh CLI has access.`,
      };
    }

    await prisma.project.updateMany({
      where: { jiraKey: data.jiraKey },
      data: { githubRepo: repoName },
    });
    logs.push("Linked repo to project in database");

    logs.push("Setting branch protection on main...");
    await github.setBranchProtection(repoName, "main");
    logs.push("Branch protection configured for main");

    await prisma.auditLog.create({
      data: {
        action: "github.repo_linked",
        actor: "system",
        details: JSON.stringify({ repo: `${owner}/${repoName}`, jiraKey: data.jiraKey }),
      },
    });

    return { success: true, logs };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Internal: Jira Project Setup ────────────────────────────────────

export async function setupJiraInternal(data: {
  projectName: string;
  jiraKey: string;
  description: string;
}): Promise<StepResult> {
  const logs: string[] = [];

  try {
    logs.push(`Creating Jira project: ${data.jiraKey}...`);
    const project = await jira.createProject(
      data.jiraKey,
      data.projectName,
      data.description
    );
    logs.push(`Jira project created: ${data.jiraKey} (id: ${project.id})`);

    logs.push("Custom fields to configure:");
    logs.push("  - Agent Team (dev/qa/architect)");
    logs.push("  - Agent Status (waiting/running/blocked/completed/failed)");
    logs.push("  - Worktree Branch");
    logs.push("  - Cost (tokens)");
    logs.push(
      "Workflow: Backlog -> To Do -> In Progress -> Code Review -> QA -> QA Passed -> Done"
    );

    // Look up auto-created Scrum board and save jiraBoardId
    try {
      const boards = await jira.getBoardsForProject(data.jiraKey);
      const scrumBoard = boards.values?.[0];
      if (scrumBoard) {
        await prisma.project.updateMany({
          where: { jiraKey: data.jiraKey },
          data: { jiraBoardId: scrumBoard.id },
        });
        logs.push(`Scrum board: ${scrumBoard.name} (id: ${scrumBoard.id})`);
      }
    } catch (e) {
      logs.push(`WARNING: Could not find Scrum board: ${(e as Error).message}`);
    }

    const jiraBaseUrl = await getJiraBaseUrl();
    const projectUrl = `${jiraBaseUrl}/jira/software/projects/${data.jiraKey}/board`;
    logs.push(`Project URL: ${projectUrl}`);

    await prisma.auditLog.create({
      data: {
        action: "jira.project_created",
        actor: "system",
        details: JSON.stringify({ key: data.jiraKey, jiraProjectId: project.id }),
      },
    });

    return { success: true, logs };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Internal: File Scaffolding ──────────────────────────────────────

export async function scaffoldFilesInternal(data: {
  projectName: string;
  localPath: string;
  jiraKey: string;
}): Promise<StepResult> {
  const logs: string[] = [];
  const expandedPath = data.localPath.replace(/^~/, process.env.HOME || "");
  const repoName = data.projectName.toLowerCase().replace(/\s+/g, "-");

  try {
    const project = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
    });
    if (!project) {
      return { success: false, logs, error: "Project not found in database" };
    }

    const techStack = project.techStack || "";
    const description = project.description || "";

    logs.push("Rendering templates...");
    const files = renderAllTemplates({
      projectName: data.projectName,
      jiraKey: data.jiraKey,
      githubRepo: repoName,
      techStack,
      description,
      archProfile: project.archProfile,
      environments: project.environments,
      codebaseAnalysis: project.codebaseAnalysis,
    });

    if (project.prdContent) {
      files["PRD.md"] = project.prdContent;
      logs.push("Including PRD.md from Architect");
    }
    if (project.ardContent) {
      files["ARD.md"] = project.ardContent;
      logs.push("Including ARD.md from Architect");
    }

    for (const [relativePath, content] of Object.entries(files)) {
      const fullPath = join(expandedPath, relativePath);
      const dir = join(fullPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
      logs.push(`Created: ${relativePath}`);
    }

    const gitignorePath = join(expandedPath, ".gitignore");
    if (!existsSync(gitignorePath)) {
      writeFileSync(
        gitignorePath,
        "node_modules/\n.env\n.env.local\ndist/\n.next/\n*.db\n*.db-journal\n",
        "utf-8"
      );
      logs.push("Created: .gitignore");
    }

    logs.push("Initializing git and pushing to GitHub...");
    await github.initAndPush(expandedPath, repoName, project.archProfile);
    logs.push("Code pushed to GitHub");

    if (project.archProfile === "complex") {
      logs.push("Setting branch protection on develop...");
      await github.setBranchProtection(repoName, "develop");
      logs.push("Branch protection configured for develop");
    }

    await prisma.auditLog.create({
      data: {
        action: "scaffold.completed",
        actor: "system",
        details: JSON.stringify({ files: Object.keys(files), repoName }),
      },
    });

    return { success: true, logs };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Internal: Lyra Team Configuration ───────────────────────────────

export async function setupLyraTeamInternal(data: {
  projectName: string;
  jiraKey: string;
  templateName?: string;
}): Promise<StepResult> {
  const logs: string[] = [];

  try {
    logs.push(`Setting up Lyra team for project ${data.jiraKey}...`);

    const project = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
    });

    if (!project) {
      return { success: false, logs, error: "Project not found in database" };
    }

    // Seed built-in templates if not present
    const { seedTemplates, applyTemplate } = await import("@/lib/team-templates");
    await seedTemplates();
    logs.push("Team templates seeded");

    // Apply template (default: Minimal for ~3 agents)
    const template = data.templateName || "Minimal";
    const result = await applyTemplate(project.id, template);
    logs.push(...result.logs);

    logs.push("");
    logs.push("Lyra services enabled:");
    logs.push("  Dispatcher — polls Jira for To Do tickets (every 15 min)");
    logs.push("  QA Runner — polls for Code Review tickets (every 15 min)");
    logs.push("  Quality Gate — validates work on agent completion");
    logs.push("  Lyra Brain — AI decisions for approvals and routing");

    await prisma.auditLog.create({
      data: {
        projectId: project.id,
        action: "lyra.team_configured",
        actor: "system",
        details: JSON.stringify({ jiraKey: data.jiraKey, template }),
      },
    });

    return { success: true, logs };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Internal: Validation ────────────────────────────────────────────

export async function runValidationInternal(data: {
  projectName: string;
  jiraKey: string;
  localPath: string;
}): Promise<StepResult> {
  const logs: string[] = [];

  try {
    logs.push("Checking project in database...");
    const project = await prisma.project.findUnique({
      where: { jiraKey: data.jiraKey },
    });
    if (!project) {
      return { success: false, logs, error: "Project not found in database" };
    }
    logs.push("Project found in database");

    logs.push("Checking GitHub repo...");
    const repoName = data.projectName.toLowerCase().replace(/\s+/g, "-");
    try {
      await github.getRepoInfo(repoName);
      logs.push("GitHub repo verified");
    } catch {
      logs.push("WARNING: GitHub repo not accessible (may need to verify manually)");
    }

    logs.push("Testing Jira connection...");
    const jiraTest = await jira.testConnection();
    if (jiraTest.ok) {
      logs.push(`Jira connected as: ${jiraTest.user}`);
    } else {
      logs.push(`WARNING: Jira connection failed: ${jiraTest.error}`);
    }

    logs.push("Creating validation ticket...");
    try {
      const issue = await jira.createIssue(
        data.jiraKey,
        "Task",
        `Validation: ${data.projectName} onboarding complete`,
        "This ticket was auto-created by Lyra Control to validate the onboarding process. It can be closed."
      );
      logs.push(`Created: ${issue.key}`);
      await jira.deleteIssue(issue.key);
      logs.push(`Cleaned up validation ticket: ${issue.key}`);
    } catch (e) {
      logs.push(`WARNING: Could not create/delete test ticket: ${(e as Error).message}`);
    }

    logs.push("Checking scaffolded files...");
    const expandedPath = data.localPath.replace(/^~/, process.env.HOME || "");
    const requiredFiles = [
      "CLAUDE.md",
      ".github/workflows/ci.yml",
      ".github/workflows/auto-merge.yml",
      ".github/workflows/rollback.yml",
    ];

    if (project.prdStatus === "approved") {
      requiredFiles.push("PRD.md", "ARD.md");
    }

    for (const file of requiredFiles) {
      if (existsSync(join(expandedPath, file))) {
        logs.push(`  Found: ${file}`);
      } else {
        logs.push(`  MISSING: ${file}`);
      }
    }

    const agents = await prisma.agent.findMany({
      where: { projectId: project.id },
    });
    logs.push(`Agents registered: ${agents.length}`);
    for (const a of agents) {
      logs.push(`  ${a.name} (${a.role}) — ${a.model}`);
    }

    await prisma.project.update({
      where: { id: project.id },
      data: { status: "active" },
    });
    logs.push("Project status: active");

    await prisma.auditLog.create({
      data: {
        projectId: project.id,
        action: "onboarding.completed",
        actor: "system",
        details: JSON.stringify({ validation: "passed" }),
      },
    });

    logs.push("");
    logs.push("Onboarding complete! The project is ready for development.");

    return { success: true, logs };
  } catch (e) {
    return { success: false, logs, error: (e as Error).message };
  }
}

// ── Execute All: runs all side effects in sequence ──────────────────

export async function executeOnboarding(jiraKey: string): Promise<ExecuteResult> {
  const steps: ExecuteResult["steps"] = [];

  try {
    const project = await prisma.project.findUnique({
      where: { jiraKey },
    });
    if (!project) {
      return { success: false, steps, error: "Project not found" };
    }

    // 1. GitHub
    const hasExistingRepo = Boolean(project.existingRepo?.trim());
    let githubResult: StepResult;

    if (hasExistingRepo) {
      githubResult = await useExistingGitHubInternal({
        jiraKey,
        repoUrl: project.existingRepo!,
      });
    } else {
      githubResult = await setupGitHubInternal({
        projectName: project.name,
        description: project.description || project.vision?.split("\n")[0].slice(0, 200) || "",
      });
    }
    steps.push({
      name: "GitHub",
      status: githubResult.success ? "success" : "failed",
      logs: githubResult.logs,
    });
    if (!githubResult.success) {
      return { success: false, steps, error: `GitHub setup failed: ${githubResult.error}` };
    }

    // 2. Jira
    const jiraResult = await setupJiraInternal({
      projectName: project.name,
      jiraKey,
      description: project.description || "",
    });
    steps.push({
      name: "Jira",
      status: jiraResult.success ? "success" : "failed",
      logs: jiraResult.logs,
    });
    if (!jiraResult.success) {
      return { success: false, steps, error: `Jira setup failed: ${jiraResult.error}` };
    }

    // 3. Scaffold
    const scaffoldResult = await scaffoldFilesInternal({
      projectName: project.name,
      localPath: project.path,
      jiraKey,
    });
    steps.push({
      name: "Scaffold",
      status: scaffoldResult.success ? "success" : "failed",
      logs: scaffoldResult.logs,
    });
    if (!scaffoldResult.success) {
      return { success: false, steps, error: `Scaffolding failed: ${scaffoldResult.error}` };
    }

    // 4. Lyra Team
    const teamResult = await setupLyraTeamInternal({
      projectName: project.name,
      jiraKey,
    });
    steps.push({
      name: "Team Setup",
      status: teamResult.success ? "success" : "failed",
      logs: teamResult.logs,
    });
    if (!teamResult.success) {
      return { success: false, steps, error: `Team setup failed: ${teamResult.error}` };
    }

    // 5. Validation
    const validationResult = await runValidationInternal({
      projectName: project.name,
      jiraKey,
      localPath: project.path,
    });
    steps.push({
      name: "Validation",
      status: validationResult.success ? "success" : "failed",
      logs: validationResult.logs,
    });
    if (!validationResult.success) {
      return { success: false, steps, error: `Validation failed: ${validationResult.error}` };
    }

    return { success: true, steps };
  } catch (e) {
    return { success: false, steps, error: (e as Error).message };
  }
}
