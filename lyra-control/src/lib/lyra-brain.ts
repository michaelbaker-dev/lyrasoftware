/**
 * Lyra Brain — core AI decision engine.
 * Uses OpenRouter for all reasoning to preserve Claude Max budget for coding agents.
 * Maintains memory, personality, and structured decision-making.
 */

import { chat } from "./openrouter";
import { prisma } from "./db";
import { lyraEvents, think } from "./lyra-events";
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
  think("brain", "start", `Evaluating: ${context.event} for ${context.ticketKey || "project"}`, { projectId: context.projectId, ticketKey: context.ticketKey });

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

  think("brain", "evaluating", "Consulting AI for decision...", { projectId: context.projectId });

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

  think("brain", "decided", `Decision: ${parsed.action} (confidence: ${parsed.confidence})`, { projectId: context.projectId, ticketKey: context.ticketKey });

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

// ── Deadlock analysis ────────────────────────────────────────────────

export interface DeadlockAnalysis {
  rootCause: string;           // Why attempts keep failing
  patternIdentified: string;   // The recurring mistake across attempts
  newApproach: string;         // High-level new strategy
  promptInstructions: string;  // Specific detailed agent instructions (becomes promptOverride)
  scopeChange: "none" | "narrow" | "split";
  confidence: number;
}

export async function analyzeDeadlockedTicket(input: {
  ticketKey: string;
  projectId: string;
  summary: string;
  description: string;
  acceptanceCriteria: string[];
  gateFailures: { reasoning: string; checks: string }[];
  sessionOutputs: { output: string; completedAt: Date | null }[];
  sprintTickets: { key: string; summary: string; status: string }[];
  triageHistory: { action: string; summary: string; actionTaken: string }[];
  dependents: string[];  // tickets blocked by this one
}): Promise<DeadlockAnalysis> {
  think("brain", "start", `Analyzing deadlocked ticket ${input.ticketKey}`, { projectId: input.projectId, ticketKey: input.ticketKey });

  // Load recent memory for project context
  const recentMemory = await getContext(input.projectId, 20);

  // Load project info
  const project = await prisma.project.findUnique({
    where: { id: input.projectId },
    select: { name: true, jiraKey: true, velocityTarget: true, sprintLength: true },
  });

  // Build personality prompt
  const template = getPersonalityTemplate();
  const systemPrompt = template({
    projectContext: project
      ? `Project: ${project.name} (${project.jiraKey}), Velocity Target: ${project.velocityTarget} pts/sprint, Sprint Length: ${project.sprintLength} days`
      : undefined,
    recentMemory: recentMemory.slice(0, 10).map((m) => ({
      category: m.category,
      content: typeof m.content === "string" ? m.content.slice(0, 200) : JSON.stringify(m.content).slice(0, 200),
    })),
  });

  // Build failure history section
  const failureDetails: string[] = [];
  for (const gf of input.gateFailures) {
    failureDetails.push(`### Quality Gate Failure`);
    failureDetails.push(`Reasoning: ${gf.reasoning}`);
    try {
      const checks = JSON.parse(gf.checks) as { name: string; passed: boolean; details: string }[];
      for (const c of checks.filter((c) => !c.passed)) {
        failureDetails.push(`- FAILED: ${c.name} — ${c.details.slice(0, 500)}`);
      }
    } catch { /* invalid JSON */ }
  }

  for (const so of input.sessionOutputs) {
    const tail = (so.output || "").slice(-3000);
    if (tail) {
      failureDetails.push(`### Session Output (${so.completedAt?.toISOString() ?? "unknown"})`);
      failureDetails.push("```");
      failureDetails.push(tail);
      failureDetails.push("```");
    }
  }

  // Build triage history section
  const triageDetails = input.triageHistory.map(
    (t) => `- Action: ${t.action} | Summary: ${t.summary} | Taken: ${t.actionTaken}`
  );

  const userMessage = [
    `## Deadlocked Ticket Analysis`,
    ``,
    `### The Ticket`,
    `**${input.ticketKey}**: ${input.summary}`,
    input.description ? `\nDescription:\n${input.description.slice(0, 3000)}` : "",
    input.acceptanceCriteria.length > 0
      ? `\nAcceptance Criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}`
      : "",
    ``,
    `### Project Context (all sprint tickets)`,
    ...input.sprintTickets.map((t) => `- ${t.key}: ${t.summary} [${t.status}]`),
    ``,
    `### Dependent Tickets (blocked by this one)`,
    input.dependents.length > 0
      ? input.dependents.map((d) => `- ${d}`).join("\n")
      : "None",
    ``,
    `### Failure History (${input.gateFailures.length} gate failures, ${input.sessionOutputs.length} sessions)`,
    ...failureDetails,
    ``,
    triageDetails.length > 0 ? `### Triage History\n${triageDetails.join("\n")}` : "",
    ``,
    `## Your Task`,
    `Analyze why this ticket keeps failing. Identify the pattern of mistakes across all attempts.`,
    `Create a NEW detailed plan that gives the agent specific, DIFFERENT instructions to succeed.`,
    `Include exact file paths, commands, or approaches the agent should use.`,
    `The plan must keep the original intent of the story but may take a completely different technical approach.`,
    ``,
    `The promptInstructions field is critical — it will REPLACE the agent's entire prompt.`,
    `It must be a complete, self-contained set of instructions that includes:`,
    `- What went wrong before (specific, not generic)`,
    `- The new step-by-step approach`,
    `- Concrete technical guidance (file paths, tool commands, patterns to follow)`,
    `- How this ticket fits in the project and what depends on it`,
    `- The acceptance criteria and definition of done`,
    ``,
    `## Required Response Format`,
    `Respond ONLY with a JSON object (no markdown, no explanation outside the JSON). Example:`,
    `{"rootCause": "Agents kept creating files in wrong directory", "patternIdentified": "All attempts put source in root instead of src/", "newApproach": "Explicitly specify file paths and use existing project structure", "promptInstructions": "You are fixing ticket X. Previous agents failed because... Your step-by-step plan: 1)... 2)... 3)...", "scopeChange": "none", "confidence": 0.8}`,
    ``,
    `Fields: rootCause (string), patternIdentified (string), newApproach (string), promptInstructions (string - detailed agent instructions), scopeChange ("none" or "narrow" or "split"), confidence (0.0 to 1.0)`,
  ].filter(Boolean).join("\n");

  think("brain", "evaluating", `Consulting AI for deadlock analysis of ${input.ticketKey}...`, { projectId: input.projectId, ticketKey: input.ticketKey });

  const response = await chat(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    "openrouter/auto",
    { projectId: input.projectId, category: "decision", ticketKey: input.ticketKey }
  );

  // Extract content — handle both string and array formats from OpenRouter
  let raw: string;
  const rawContent = response.choices[0]?.message?.content;
  if (typeof rawContent === "string") {
    raw = rawContent;
  } else if (Array.isArray(rawContent)) {
    // Some models return content as [{type:"text", text:"..."}]
    raw = (rawContent as { type: string; text: string }[])
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("");
  } else if (rawContent && typeof rawContent === "object") {
    raw = JSON.stringify(rawContent);
  } else {
    raw = "{}";
  }

  console.log(`[Brain] Deadlock analysis for ${input.ticketKey} (${raw.length} chars, model: ${response.model})`);

  let parsed: DeadlockAnalysis;
  try {
    // Try multiple extraction strategies (order matters!):
    // 1. First { ... last } — most reliable since AI usually returns a JSON object
    // 2. Markdown code block with JSON content (must start with {)
    // 3. Raw response as-is
    // NOTE: We try braces FIRST because ```code``` inside JSON string values
    // would be falsely matched by the code block regex.
    let jsonStr = raw;
    const firstBrace = raw.indexOf("{");
    const lastBrace = raw.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = raw.slice(firstBrace, lastBrace + 1);
    } else {
      const codeBlockMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch && codeBlockMatch[1]!.trim().startsWith("{")) {
        jsonStr = codeBlockMatch[1]!.trim();
      }
    }

    // Clean common JSON issues: trailing commas, control characters
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, "$1");
    // eslint-disable-next-line no-control-regex
    jsonStr = jsonStr.replace(/[\x00-\x1f\x7f]/g, (ch) => ch === "\n" || ch === "\t" ? ch : " ");

    parsed = JSON.parse(jsonStr);

    // Validate required fields exist
    if (!parsed.rootCause || !parsed.promptInstructions) {
      throw new Error(`Missing required fields. Got keys: ${Object.keys(parsed).join(", ")}`);
    }
  } catch (parseErr) {
    console.error(`[Brain] Failed to parse deadlock analysis for ${input.ticketKey}:`, (parseErr as Error).message);
    console.error(`[Brain] Full raw response:`, raw);

    // Regex fallback: extract fields individually when JSON is malformed
    const rootCause = raw.match(/"rootCause"\s*:\s*"([^"]+)"/)?.[1] || "Failed to parse AI analysis";
    const patternIdentified = raw.match(/"patternIdentified"\s*:\s*"([^"]+)"/)?.[1] || "unknown";
    const newApproach = raw.match(/"newApproach"\s*:\s*"([^"]+)"/)?.[1] || "Retry with default instructions";
    const promptInstructions = raw.match(/"promptInstructions"\s*:\s*"([\s\S]*?)(?:","|\"})/)?.[1] || "";
    const scopeChangeMatch = raw.match(/"scopeChange"\s*:\s*"(none|narrow|split)"/)?.[1] as "none" | "narrow" | "split" | undefined;
    const confidence = parseFloat(raw.match(/"confidence"\s*:\s*([\d.]+)/)?.[1] || "0");

    if (rootCause !== "Failed to parse AI analysis" || promptInstructions) {
      console.log(`[Brain] Regex fallback extracted fields for ${input.ticketKey}`);
    }

    parsed = {
      rootCause,
      patternIdentified,
      newApproach,
      promptInstructions,
      scopeChange: scopeChangeMatch || "none",
      confidence,
    };
  }

  think("brain", "decided", `Deadlock analysis for ${input.ticketKey}: ${parsed.rootCause.slice(0, 100)}`, { projectId: input.projectId, ticketKey: input.ticketKey });

  // Log to memory
  await remember(input.projectId, "decision", {
    event: "deadlock_analysis",
    ticketKey: input.ticketKey,
    rootCause: parsed.rootCause,
    patternIdentified: parsed.patternIdentified,
    newApproach: parsed.newApproach,
    scopeChange: parsed.scopeChange,
    confidence: parsed.confidence,
  });

  return parsed;
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
    "Evaluate whether the following acceptance criteria have been met based on the code diff, agent output, and test results.",
    "",
    "## Acceptance Criteria",
    ...criteria.map((c, i) => `${i + 1}. ${c}`),
    "",
    "## Code Diff (summary — shows only CHANGED files, not pre-existing code)",
    diff.slice(0, 15000),
    "",
    "## Agent Output (summary)",
    agentOutput.slice(0, 4000),
    "",
    "## Important Notes",
    "- If a criterion mentions a file that is NOT in the diff, it may already exist in the codebase (not changed = not in diff).",
    "- If tests pass and TypeScript compiles, that is evidence the code is structurally correct.",
    "- Focus on whether the INTENT of each criterion is met, not just whether the diff contains explicit proof.",
    "- If the agent output shows tests passing that validate the criterion's functionality, mark it as met.",
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
        content: [
          "You are a quality gate validator. Evaluate code changes against acceptance criteria.",
          "",
          "Rules:",
          "- Be thorough but pragmatic — if tests pass and TypeScript compiles, give credit for criteria validated by those tests.",
          "- Passing tests that validate a criterion's functionality = criterion MET.",
          '- "I cannot verify" or "I cannot confirm" is NOT sufficient reason to reject. If you lack evidence of failure, mark as MET.',
          "- A file not appearing in the diff means it was not changed — it may already exist and satisfy the criterion.",
          "- When in doubt, PASS. False rejections cost more than false approvals (they burn retry budget and agent time).",
          "- Focus on whether the INTENT of each criterion is met, not whether the diff contains explicit proof of every detail.",
        ].join("\n"),
      },
      { role: "user", content: userMessage },
    ],
    "anthropic/claude-haiku-4.5",
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
