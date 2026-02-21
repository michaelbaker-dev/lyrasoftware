/**
 * Lyra Brain — core AI decision engine.
 * Uses OpenRouter for all reasoning to preserve Claude Max budget for coding agents.
 * Maintains memory, personality, and structured decision-making.
 */

import { chat } from "./openrouter";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import Handlebars from "handlebars";
import { readFileSync } from "fs";
import { join } from "path";

// ── Types ───────────────────────────────────────────────────────────

export interface LyraContext {
  projectId: string;
  event: string;
  ticketKey?: string;
  question: string;
  data: Record<string, unknown>;
}

export interface LyraDecision {
  action: string;
  reasoning: string;
  confidence: number; // 0-1
  details: Record<string, unknown>;
}

type MemoryCategory = "decision" | "observation" | "reflection" | "escalation";

// ── Personality template ────────────────────────────────────────────

let personalityTemplate: Handlebars.TemplateDelegate | null = null;

export function getPersonalityTemplate(): Handlebars.TemplateDelegate {
  if (!personalityTemplate) {
    const templatePath = join(
      process.cwd(),
      "src",
      "templates",
      "lyra-personality.hbs"
    );
    const source = readFileSync(templatePath, "utf-8");
    personalityTemplate = Handlebars.compile(source);
  }
  return personalityTemplate;
}

// ── Memory operations ───────────────────────────────────────────────

export async function remember(
  projectId: string | null,
  category: MemoryCategory,
  content: Record<string, unknown>
): Promise<void> {
  await prisma.lyraMemory.create({
    data: {
      projectId,
      category,
      content: JSON.stringify(content),
    },
  });
}

export async function getContext(
  projectId: string,
  limit: number = 50
): Promise<{ category: string; content: string; createdAt: Date }[]> {
  return prisma.lyraMemory.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { category: true, content: true, createdAt: true },
  });
}

// ── Core decision function ──────────────────────────────────────────

export async function decide(context: LyraContext): Promise<LyraDecision> {
  // Load recent memory for project context
  const recentMemory = await getContext(context.projectId, 30);

  // Load project info
  const project = await prisma.project.findUnique({
    where: { id: context.projectId },
    select: {
      name: true,
      jiraKey: true,
      velocityTarget: true,
      sprintLength: true,
    },
  });

  // Build personality prompt with context
  const template = getPersonalityTemplate();
  const systemPrompt = template({
    projectContext: project
      ? `Project: ${project.name} (${project.jiraKey}), Velocity Target: ${project.velocityTarget} pts/sprint, Sprint Length: ${project.sprintLength} days`
      : undefined,
    recentMemory: recentMemory.slice(0, 20).map((m) => ({
      category: m.category,
      content:
        typeof m.content === "string"
          ? m.content.slice(0, 200)
          : JSON.stringify(m.content).slice(0, 200),
    })),
  });

  const userMessage = [
    `## Current Event: ${context.event}`,
    context.ticketKey ? `Ticket: ${context.ticketKey}` : "",
    "",
    `## Question`,
    context.question,
    "",
    `## Context Data`,
    JSON.stringify(context.data, null, 2),
    "",
    `## Required Response Format`,
    `Respond ONLY with valid JSON matching this schema:`,
    `{`,
    `  "action": "string — the action to take (e.g., 'approve', 'reject', 'retry', 'escalate', 'assign')",`,
    `  "reasoning": "string — explain why you chose this action",`,
    `  "confidence": 0.0-1.0,`,
    `  "details": { ... any action-specific data }`,
    `}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    "openrouter/auto",
    { projectId: context.projectId, category: "decision", ticketKey: context.ticketKey }
  );

  const raw = response.choices[0]?.message?.content || "{}";

  // Parse JSON from response (handle markdown code blocks)
  let parsed: LyraDecision;
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      raw,
    ];
    parsed = JSON.parse(jsonMatch[1]!.trim());
  } catch {
    parsed = {
      action: "error",
      reasoning: `Failed to parse AI response: ${raw.slice(0, 500)}`,
      confidence: 0,
      details: { rawResponse: raw },
    };
  }

  // Log decision to memory
  await remember(context.projectId, "decision", {
    event: context.event,
    ticketKey: context.ticketKey,
    question: context.question,
    decision: parsed.action,
    reasoning: parsed.reasoning,
    confidence: parsed.confidence,
  });

  // Emit decision event
  lyraEvents.emit("lyra:decision", {
    projectId: context.projectId,
    category: "decision",
    action: parsed.action,
    reasoning: parsed.reasoning,
    confidence: parsed.confidence,
  });

  return parsed;
}

// ── Reflect — retrospective analysis ────────────────────────────────

export async function reflect(projectId: string): Promise<string> {
  const recentDecisions = await prisma.lyraMemory.findMany({
    where: { projectId, category: "decision" },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (recentDecisions.length === 0) {
    return "No decisions to reflect on yet.";
  }

  const summaryPrompt = [
    "Review these recent decisions and provide a brief retrospective analysis.",
    "Identify patterns, areas for improvement, and what went well.",
    "",
    "Decisions:",
    ...recentDecisions.map((d) => `- ${d.content}`),
  ].join("\n");

  const response = await chat(
    [
      {
        role: "system",
        content:
          "You are Lyra, an AI Scrum Master. Analyze your recent decisions and provide actionable insights.",
      },
      { role: "user", content: summaryPrompt },
    ],
    "openrouter/auto",
    { projectId, category: "reflection" }
  );

  const reflection = response.choices[0]?.message?.content || "";

  // Store reflection in memory
  await remember(projectId, "reflection", {
    type: "retrospective",
    analysis: reflection,
    decisionCount: recentDecisions.length,
  });

  return reflection;
}

// ── Validate acceptance criteria via AI ─────────────────────────────

export async function validateAcceptanceCriteria(
  criteria: string[],
  diff: string,
  agentOutput: string,
  projectId?: string
): Promise<{
  passed: boolean;
  details: string;
  criteriaResults: { criterion: string; met: boolean; explanation: string }[];
}> {
  const userMessage = [
    "## Task",
    "Evaluate whether the following acceptance criteria have been met based on the code diff and agent output.",
    "",
    "## Acceptance Criteria",
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "## Code Diff (summary)",
    diff.slice(0, 8000),
    "",
    "## Agent Output (summary)",
    agentOutput.slice(0, 4000),
    "",
    "## Required Response Format",
    "Respond ONLY with valid JSON:",
    "{",
    '  "passed": true/false,',
    '  "details": "overall summary",',
    '  "criteriaResults": [',
    '    { "criterion": "...", "met": true/false, "explanation": "..." }',
    "  ]",
    "}",
  ].join("\n");

  const response = await chat(
    [
      {
        role: "system",
        content:
          "You are a quality gate validator. Evaluate code changes against acceptance criteria. Be strict — only mark a criterion as met if there is clear evidence in the diff or output.",
      },
      { role: "user", content: userMessage },
    ],
    "openrouter/auto",
    { projectId, category: "qa" }
  );

  const raw = response.choices[0]?.message?.content || "{}";
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [
      null,
      raw,
    ];
    return JSON.parse(jsonMatch[1]!.trim());
  } catch {
    return {
      passed: false,
      details: `Failed to parse validation response: ${raw.slice(0, 500)}`,
      criteriaResults: criteria.map((c) => ({
        criterion: c,
        met: false,
        explanation: "Validation failed to parse",
      })),
    };
  }
}
