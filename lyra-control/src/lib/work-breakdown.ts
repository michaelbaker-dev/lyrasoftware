/**
 * AI Work Breakdown — generates Features → Epics → Stories from PRD + ARD,
 * then creates corresponding issues in Jira.
 */

import { chat } from "./openrouter";
import { prisma } from "./db";
import * as jira from "./jira";
import { trackUsage, estimateCloudCost } from "./cost-tracker";
import { getAllRoles, buildRoleListForPrompt } from "./role-config";
import { isClaudeCodeModel, chatViaClaude } from "./claude-code-chat";

// ── Types ────────────────────────────────────────────────────────────

export type StoryType =
  | "api_endpoint"
  | "database_schema"
  | "configuration"
  | "ui_component"
  | "testing"
  | "architecture"
  | "documentation"
  | "auth"
  | "cicd"
  | "security"
  | "general";

export type StructuredDescription = {
  objective: string;          // What this story accomplishes (1-2 sentences)
  context: string;            // Why needed, how it fits into the epic
  targetFiles: string[];      // Files to create or modify
  technicalApproach: string;  // How to implement
  outOfScope: string[];       // What NOT to do
};

export type StructuredAcceptanceCriterion = {
  criterion: string;          // Testable statement
  verification: string;       // How to verify (command, test, manual check)
};

export type StoryBreakdown = {
  id: string;                    // Temp ID like "S1", "S2" for referencing within breakdown
  summary: string;
  storyType: StoryType;
  storyPoints: number;
  assigneeRole: string;          // Data-driven: validated against RoleConfig table
  dependsOn?: string[];          // Temp IDs of stories this depends on
  description: string | StructuredDescription;  // backward compat: string OR object
  acceptanceCriteria: (string | StructuredAcceptanceCriterion)[];  // backward compat
};

export type EpicBreakdown = {
  summary: string;
  description: string;
  stories: StoryBreakdown[];
};

export type FeatureBreakdown = {
  name: string;
  epics: EpicBreakdown[];
};

export type WorkBreakdown = {
  features: FeatureBreakdown[];
};

// ── AI Generation ────────────────────────────────────────────────────

async function buildBreakdownSystemPrompt(): Promise<string> {
  const roleList = await buildRoleListForPrompt();

  return `You are the Architect agent for Lyra, an AI-driven development platform.
Your job is to decompose an approved PRD and ARD into a structured work breakdown.

CRITICAL: You MUST respond with ONLY a valid JSON object. No prose, no explanation, no markdown fences, no text before or after the JSON. Your entire response must be parseable by JSON.parse().

Return a single JSON object with this exact schema:
{
  "features": [
    {
      "name": "Feature Name",
      "epics": [
        {
          "summary": "Epic summary",
          "description": "Epic description",
          "stories": [
            {
              "id": "S1",
              "summary": "Story summary",
              "storyType": "api_endpoint",
              "description": {
                "objective": "What this story accomplishes",
                "context": "Why needed, how it fits into the larger feature",
                "targetFiles": ["src/path/to/file.ts"],
                "technicalApproach": "How to implement — libraries, patterns, algorithm",
                "outOfScope": ["Things NOT to implement in this story"]
              },
              "storyPoints": 3,
              "assigneeRole": "dev",
              "acceptanceCriteria": [
                { "criterion": "Specific testable assertion", "verification": "How to verify this" }
              ],
              "dependsOn": []
            }
          ]
        }
      ]
    }
  ]
}

Rules:
- Story points MUST be Fibonacci: 1, 2, 3, 5, or 8. Never exceed 8 — split larger work into multiple stories.
- Each story MUST have a unique "id" field (e.g., "S1", "S2", "S3"). IDs must be globally unique across all features/epics.
- assigneeRole MUST be one of: ${roleList}.
- Every epic MUST include at least one QA story for testing that epic's functionality.
- Architecture/design stories come first within each epic.
- Each story should be completable in one Claude Code session (~30 minutes of AI work).
- Be thorough — cover all requirements from the PRD.
- Keep story summaries concise but descriptive (under 80 chars).
- Include acceptance criteria as a checklist for each story.

Dependency rules:
- Each story MAY have a "dependsOn" array listing IDs of stories that must complete before it can start.
- Architecture/design stories have no dependencies (they go first).
- Dev stories typically depend on the architect story in their epic.
- QA stories depend on the dev stories they test.
- Security stories depend on all dev stories in their epic.
- Documentation stories depend on dev + QA stories (document what's been built and tested).
- Cross-epic dependencies are allowed (e.g., "Build API" in Epic A blocks "API Docs" in Epic B).
- If unsure, omit dependsOn — the system will apply default ordering rules based on role phases.

Story types — classify each story:
- "api_endpoint": Creating or modifying an API endpoint
- "database_schema": Database model, migration, or schema change
- "configuration": Config files (ESLint, Prettier, tsconfig, Docker, etc.)
- "ui_component": Frontend component, page, or layout
- "testing": QA test stories
- "architecture": Scaffolding, interfaces, type definitions, project structure
- "documentation": README, API docs, guides
- "auth": Authentication or authorization logic
- "cicd": CI/CD pipelines, deployment
- "security": Security audit, hardening
- "general": Anything that doesn't fit above

Story description rules:
- description MUST be a structured object with: objective, context, targetFiles, technicalApproach, outOfScope
- targetFiles: list every file the agent should create or modify (relative to project root)
- technicalApproach: name the specific library, pattern, or algorithm to use
- outOfScope: list what other stories handle, so the agent doesn't overreach
- context: explain how this story relates to its dependencies and the feature goal
- If the story depends on another story's output, describe that interface in context

Acceptance criteria rules (enhanced):
- Minimum 3 acceptance criteria per story
- Each criterion MUST be an object with "criterion" and "verification" fields
- "criterion": a single testable assertion (not a group)
- "verification": the specific command, test, or check to prove it works
- For APIs: include HTTP status code and response shape
- For errors: include specific error codes
- For config: include the key settings that must be present
- Do NOT include standard Definition of Done items (e.g., "tests pass", "code compiles", "PR created") — those are enforced separately.
- Use concrete, measurable language: "API returns 200 with user object" not "API works correctly".

EXISTING CODEBASE rules (apply only when a codebase analysis is provided):
- Study the existing code structure, API routes, components, models, and source excerpts carefully.
- DO NOT create stories to rebuild functionality that already exists and works.
- Frame stories as INCREMENTAL changes: "Add X to existing Y", "Extend Z endpoint with...", "Refactor W to support...".
- Reference specific existing files, routes, and components in story descriptions so the dev agent knows where to make changes.
- If the PRD describes features that partially exist, create stories only for the DELTA — what's missing or needs modification.
- Include an early "Codebase audit" or "Integration assessment" architect story if the existing code needs refactoring to support new features.
- Story descriptions should mention which existing files/modules will be modified.`;
}

async function getLmStudioUrl(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "lm_studio_url" },
  });
  return setting?.value || "http://192.168.56.203:1234";
}

async function chatWithRouting(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  model: string,
  costContext?: { projectId?: string }
): Promise<string> {
  if (model.startsWith("local:")) {
    const localModelId = model.slice("local:".length);
    const lmStudioUrl = await getLmStudioUrl();
    const startTime = Date.now();
    const response = await fetch(`${lmStudioUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: localModelId,
        messages,
        temperature: 0.7,
        max_tokens: 16384,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LM Studio error ${response.status}: ${body}`);
    }
    const data = await response.json();
    const durationMs = Date.now() - startTime;

    // Track local model usage with synthetic cost
    const usage = data.usage;
    if (usage) {
      try {
        await trackUsage({
          projectId: costContext?.projectId,
          category: "breakdown",
          provider: "lmstudio",
          requestedModel: localModelId,
          actualModel: data.model || localModelId,
          promptTokens: usage.prompt_tokens || 0,
          completionTokens: usage.completion_tokens || 0,
          totalTokens: usage.total_tokens || 0,
          cost: 0,
          durationMs,
          isLocal: true,
        });
      } catch (e) {
        console.error("[WorkBreakdown] Cost tracking failed (non-fatal):", e);
      }
    }

    return data.choices?.[0]?.message?.content || "";
  }

  // Claude Code CLI — route claude-code/* models through the CLI
  if (isClaudeCodeModel(model)) {
    const result = await chatViaClaude(messages, model);

    // Track usage
    try {
      await trackUsage({
        projectId: costContext?.projectId,
        category: "breakdown",
        provider: "claude-code",
        requestedModel: model,
        actualModel: result.cliModel,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0, // Max subscription
        durationMs: result.durationMs,
        isLocal: false,
      });
    } catch (e) {
      console.error("[WorkBreakdown] Cost tracking failed (non-fatal):", e);
    }

    return result.content;
  }

  // OpenRouter — cost tracking is handled inside chat()
  const response = await chat(
    messages,
    model,
    {
      projectId: costContext?.projectId,
      category: "breakdown",
    },
    {
      response_format: { type: "json_object" },
      max_tokens: 16384,
    }
  );
  return response.choices[0]?.message?.content || "";
}

function validateStoryStructure(story: StoryBreakdown, logs: string[]): void {
  // Structured description check (warn, don't reject)
  if (typeof story.description === "string") {
    logs.push(`  WARN: Story ${story.id} has prose description — structured object preferred`);
  } else {
    if (!story.description.targetFiles?.length) {
      logs.push(`  WARN: Story ${story.id} missing targetFiles`);
    }
    if (!story.description.technicalApproach) {
      logs.push(`  WARN: Story ${story.id} missing technicalApproach`);
    }
  }

  // AC quality check
  if (story.acceptanceCriteria.length < 3) {
    logs.push(`  WARN: Story ${story.id} has only ${story.acceptanceCriteria.length} AC (recommend 3+)`);
  }
  for (const ac of story.acceptanceCriteria) {
    if (typeof ac === "string") {
      logs.push(`  WARN: Story ${story.id} has plain-string AC — structured {criterion, verification} preferred`);
      break;
    }
  }

  // Points check
  if (![1, 2, 3, 5, 8].includes(story.storyPoints)) {
    logs.push(`  WARN: Story ${story.id} has non-Fibonacci points: ${story.storyPoints}`);
  }
}

/**
 * Attempt to extract and parse JSON from a raw AI response.
 * Returns { success, data, truncated, error }.
 * `truncated` is true when the JSON appears cut off (missing closing braces).
 */
function tryParseBreakdownJson(raw: string): {
  success: boolean;
  data?: Record<string, unknown>;
  truncated: boolean;
  error?: string;
} {
  let jsonStr = raw.trim();

  // Strip markdown fences
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  } else {
    // If no closing fence, strip opening fence only (truncated response)
    const openFence = jsonStr.match(/```(?:json)?\s*([\s\S]*)/);
    if (openFence && !jsonStr.includes("```", openFence.index! + 3 + (openFence[0].startsWith("```json") ? 4 : 0))) {
      jsonStr = openFence[1].trim();
    }
  }

  // Extract outermost { ... } block
  if (!jsonStr.startsWith("{") && !jsonStr.startsWith("[")) {
    const firstBrace = jsonStr.indexOf("{");
    const lastBrace = jsonStr.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      jsonStr = jsonStr.slice(firstBrace, lastBrace + 1);
    } else if (firstBrace !== -1) {
      jsonStr = jsonStr.slice(firstBrace); // No closing brace — likely truncated
    }
  }

  try {
    const data = JSON.parse(jsonStr) as Record<string, unknown>;
    return { success: true, data, truncated: false };
  } catch (e) {
    const errMsg = (e as Error).message;
    // "Unexpected end of JSON input" = truncation
    const truncated = errMsg.includes("end of JSON") || errMsg.includes("Unexpected end");
    return { success: false, truncated, error: errMsg };
  }
}

export async function generateWorkBreakdown(
  prdContent: string,
  ardContent: string,
  model: string = "openrouter/auto",
  feedback?: string,
  projectId?: string,
  codebaseContext?: string | null
): Promise<{ breakdown: WorkBreakdown; rawResponse: string; validationLogs: string[] }> {
  const userPrompt = [
    "## PRD",
    prdContent,
    "",
    "## ARD",
    ardContent,
    codebaseContext ? `\n## Existing Codebase Analysis\n${codebaseContext}\n\nIMPORTANT: This is an existing codebase. Generate stories that build ON TOP of what already exists. Do not recreate existing functionality. Reference specific existing files and modules in story descriptions.` : "",
    feedback ? `\n## Feedback\n${feedback}\n\nPlease adjust the breakdown based on this feedback.` : "",
    "",
    'REMINDER: Respond with ONLY the JSON object. Start your response with { and end with }. No other text.',
  ].join("\n");

  const systemPrompt = await buildBreakdownSystemPrompt();

  const initialMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  // Allow up to 2 continuation attempts if the JSON is truncated
  let fullResponse = "";
  const MAX_CONTINUATIONS = 2;

  for (let attempt = 0; attempt <= MAX_CONTINUATIONS; attempt++) {
    let rawChunk: string;

    if (attempt === 0) {
      rawChunk = await chatWithRouting(initialMessages, model, { projectId });
    } else {
      // Continuation: new single-turn call with the truncated output in the prompt
      // Extract just the JSON portion so far
      let partialJson = fullResponse.trim();
      const openFence = partialJson.match(/```(?:json)?\s*/);
      if (openFence) partialJson = partialJson.slice(openFence.index! + openFence[0].length);
      if (!partialJson.startsWith("{")) {
        const fb = partialJson.indexOf("{");
        if (fb !== -1) partialJson = partialJson.slice(fb);
      }

      // Use the last ~4000 chars to give enough context without exceeding limits
      const tail = partialJson.length > 4000 ? partialJson.slice(-4000) : partialJson;

      rawChunk = await chatWithRouting(
        [
          { role: "system", content: "You are completing a truncated JSON response. Output ONLY the remaining JSON to complete the object. No markdown fences, no explanation. Continue exactly from where the previous output ended." },
          { role: "user", content: `The following JSON was truncated. Output ONLY the remaining text needed to complete it. Continue from exactly where it stops:\n\n...${tail}` },
        ],
        model,
        { projectId }
      );
    }

    fullResponse += rawChunk;

    // Try to parse the accumulated response
    const parseResult = tryParseBreakdownJson(fullResponse);
    if (parseResult.success) {
      break; // Valid JSON — we're done
    }

    // If JSON is truncated (not a structural error), continue
    if (attempt < MAX_CONTINUATIONS && parseResult.truncated) {
      console.log(`[WorkBreakdown] JSON truncated (attempt ${attempt + 1}/${MAX_CONTINUATIONS}), requesting continuation... (response length: ${fullResponse.length})`);
      continue;
    }

    // Not truncated, just bad JSON — fail
    break;
  }

  const rawResponse = fullResponse;

  // Final parse attempt
  const finalParse = tryParseBreakdownJson(rawResponse);
  if (!finalParse.success) {
    console.error("[WorkBreakdown] JSON parse failed after continuations.");
    console.error("[WorkBreakdown] Raw response length:", rawResponse.length);
    console.error("[WorkBreakdown] Raw (first 500 chars):", rawResponse.slice(0, 500));
    console.error("[WorkBreakdown] Raw (last 500 chars):", rawResponse.slice(-500));
    // Show a helpful preview in the thrown error so the UI can display it
    const preview = rawResponse.slice(0, 120).replace(/\n/g, " ");
    throw new Error(`Invalid breakdown: AI returned non-JSON response. Preview: "${preview}..." — Try a different model (claude-code/sonnet or openrouter/auto).`);
  }

  let parsed = finalParse.data!;

  // Handle Claude Code CLI envelope leaking through
  if (typeof parsed.result === "string" && !parsed.features) {
    const innerParse = tryParseBreakdownJson(parsed.result as string);
    if (innerParse.success) {
      parsed = innerParse.data!;
    }
  }

  const breakdown = parsed as unknown as WorkBreakdown;

  // Validate structure
  if (!breakdown.features || !Array.isArray(breakdown.features)) {
    console.error("[WorkBreakdown] Parsed object keys:", Object.keys(parsed));
    console.error("[WorkBreakdown] Raw response (first 2000 chars):", rawResponse.slice(0, 2000));
    throw new Error("Invalid breakdown: missing features array. AI response keys: " + Object.keys(parsed).join(", "));
  }

  const validationLogs: string[] = [];

  for (const feature of breakdown.features) {
    if (!feature.epics || !Array.isArray(feature.epics)) {
      throw new Error(`Invalid breakdown: feature "${feature.name}" missing epics`);
    }
    for (const epic of feature.epics) {
      if (!epic.stories || !Array.isArray(epic.stories)) {
        throw new Error(`Invalid breakdown: epic "${epic.summary}" missing stories`);
      }
      for (const story of epic.stories) {
        validateStoryStructure(story, validationLogs);
      }
    }
  }

  if (validationLogs.length > 0) {
    console.log("[WorkBreakdown] Validation warnings:\n" + validationLogs.join("\n"));
  }

  return { breakdown, rawResponse, validationLogs };
}

// ── Jira Creation ────────────────────────────────────────────────────

export async function createBreakdownInJira(
  projectKey: string,
  breakdown: WorkBreakdown
): Promise<{ created: number; createdKeys: string[]; logs: string[] }> {
  const logs: string[] = [];
  let created = 0;

  const storyPointsField = await jira.getStoryPointsFieldId();
  if (storyPointsField) {
    logs.push(`Story points field: ${storyPointsField}`);
  } else {
    logs.push("WARNING: Story points custom field not found — points will not be set");
  }

  // Map: temp story ID → { jiraKey, role, epicKey }
  const storyMap = new Map<string, { jiraKey: string; role: string; epicKey: string }>();
  // Track stories per epic for phase fallback
  const epicStories = new Map<string, { tempId: string; jiraKey: string; role: string; hasDeps: boolean }[]>();

  for (const feature of breakdown.features) {
    logs.push(`Feature: ${feature.name}`);

    for (const epic of feature.epics) {
      // Create Epic
      const epicIssue = await jira.createIssue(
        projectKey,
        "Epic",
        `[${feature.name}] ${epic.summary}`,
        epic.description
      );
      logs.push(`  Epic: ${epicIssue.key} — ${epic.summary}`);
      created++;

      const epicStoriesList: { tempId: string; jiraKey: string; role: string; hasDeps: boolean }[] = [];

      for (const story of epic.stories) {
        // Build description with acceptance criteria and role
        const desc = story.description;
        const descParts: string[] = [];

        if (typeof desc === "object" && desc !== null) {
          // Structured description
          descParts.push(`**Objective:** ${desc.objective}`, "");
          if (desc.context) descParts.push(`**Context:** ${desc.context}`, "");
          if (desc.targetFiles?.length) {
            descParts.push("**Target Files:**", ...desc.targetFiles.map((f) => `- \`${f}\``), "");
          }
          if (desc.technicalApproach) descParts.push(`**Technical Approach:** ${desc.technicalApproach}`, "");
          if (desc.outOfScope?.length) {
            descParts.push("**Out of Scope:**", ...desc.outOfScope.map((s) => `- ${s}`), "");
          }
        } else {
          // Legacy string description
          descParts.push(String(desc), "");
        }

        descParts.push("**Acceptance Criteria:**");
        for (const ac of story.acceptanceCriteria) {
          if (typeof ac === "object" && ac !== null) {
            descParts.push(`- [ ] ${ac.criterion}`, `  _Verify: ${ac.verification}_`);
          } else {
            descParts.push(`- [ ] ${ac}`);
          }
        }

        descParts.push("", `**Story Type**: ${story.storyType || "general"}`);
        descParts.push(`**Assigned Role**: ${story.assigneeRole}`);
        descParts.push(`**Story Points**: ${story.storyPoints}`);

        // Convert descParts to ADF paragraphs for proper Jira rendering
        const adfContent = descParts
          .join("\n")
          .split("\n\n")
          .filter(Boolean)
          .map((block) => ({
            type: "paragraph" as const,
            content: [{ type: "text" as const, text: block }],
          }));

        const adfDoc = { type: "doc", version: 1, content: adfContent };
        const storyIssue = await jira.createIssueWithAdf(
          projectKey,
          "Story",
          story.summary,
          adfDoc
        );
        logs.push(`    Story: ${storyIssue.key} — ${story.summary} (${story.storyPoints}pts, ${story.assigneeRole})`);
        created++;

        // Track in story map
        storyMap.set(story.id, { jiraKey: storyIssue.key, role: story.assigneeRole, epicKey: epicIssue.key });
        epicStoriesList.push({
          tempId: story.id,
          jiraKey: storyIssue.key,
          role: story.assigneeRole,
          hasDeps: !!(story.dependsOn && story.dependsOn.length > 0),
        });

        // Set story points if field exists
        if (storyPointsField) {
          try {
            await jira.updateIssueFields(storyIssue.key, {
              [storyPointsField]: story.storyPoints,
            });
          } catch {
            // Non-fatal — story was created, points just weren't set
          }
        }

        // Link story to epic via parent field
        try {
          await jira.updateIssueFields(storyIssue.key, {
            parent: { key: epicIssue.key },
          });
        } catch {
          // Non-fatal — linking may not work on all Jira configurations
          logs.push(`    WARNING: Could not link ${storyIssue.key} to epic ${epicIssue.key}`);
        }
      }

      epicStories.set(epicIssue.key, epicStoriesList);
    }
  }

  // ── Pass 1: AI-explicit dependencies ──────────────────────────────
  logs.push("");
  logs.push("Dependencies created:");

  for (const feature of breakdown.features) {
    for (const epic of feature.epics) {
      for (const story of epic.stories) {
        if (!story.dependsOn || story.dependsOn.length === 0) continue;

        const thisStory = storyMap.get(story.id);
        if (!thisStory) continue;

        for (const depId of story.dependsOn) {
          const depStory = storyMap.get(depId);
          if (!depStory) {
            logs.push(`  WARNING: ${thisStory.jiraKey} depends on unknown ID "${depId}" — skipped`);
            continue;
          }

          try {
            await jira.linkIssues(depStory.jiraKey, thisStory.jiraKey, "Blocks");
            logs.push(`  ${depStory.jiraKey} [${depStory.role}] → ${thisStory.jiraKey} [${thisStory.role}] (AI-explicit)`);
          } catch (e) {
            logs.push(`  WARNING: Failed to link ${depStory.jiraKey} → ${thisStory.jiraKey}: ${(e as Error).message}`);
          }
        }
      }
    }
  }

  // ── Pass 2: Phase-map fallback (within each epic) ─────────────────
  const roles = await getAllRoles();
  const rolePhaseMap = new Map(roles.map((r) => [r.role, r.phase]));

  for (const [epicKey, stories] of epicStories) {
    // Only apply fallback to stories that have NO explicit dependsOn
    const storiesNeedingFallback = stories.filter((s) => !s.hasDeps);
    if (storiesNeedingFallback.length === 0) continue;

    // Group all stories in this epic by phase
    const phaseGroups = new Map<number, { jiraKey: string; role: string }[]>();
    for (const s of stories) {
      const phase = rolePhaseMap.get(s.role) ?? 50;
      if (!phaseGroups.has(phase)) phaseGroups.set(phase, []);
      phaseGroups.get(phase)!.push({ jiraKey: s.jiraKey, role: s.role });
    }

    const sortedPhases = [...phaseGroups.keys()].sort((a, b) => a - b);

    for (const story of storiesNeedingFallback) {
      const storyPhase = rolePhaseMap.get(story.role) ?? 50;

      // Find the highest phase group that's lower than this story's phase
      const lowerPhases = sortedPhases.filter((p) => p < storyPhase);
      if (lowerPhases.length === 0) continue;

      const nearestLowerPhase = lowerPhases[lowerPhases.length - 1];
      const blockers = phaseGroups.get(nearestLowerPhase) || [];

      for (const blocker of blockers) {
        try {
          await jira.linkIssues(blocker.jiraKey, story.jiraKey, "Blocks");
          logs.push(`  ${blocker.jiraKey} [${blocker.role}] → ${story.jiraKey} [${story.role}] (phase fallback)`);
        } catch (e) {
          logs.push(`  WARNING: Failed to link ${blocker.jiraKey} → ${story.jiraKey}: ${(e as Error).message}`);
        }
      }
    }
  }

  const createdKeys = [...storyMap.values()].map((s) => s.jiraKey);
  logs.push(`Total issues created: ${created}`);
  return { created, createdKeys, logs };
}

// ── Helpers ──────────────────────────────────────────────────────────

export function countTotalPoints(breakdown: WorkBreakdown): number {
  let total = 0;
  for (const feature of breakdown.features) {
    for (const epic of feature.epics) {
      for (const story of epic.stories) {
        total += story.storyPoints;
      }
    }
  }
  return total;
}

export function countStories(breakdown: WorkBreakdown): number {
  let total = 0;
  for (const feature of breakdown.features) {
    for (const epic of feature.epics) {
      total += epic.stories.length;
    }
  }
  return total;
}

export function countEpics(breakdown: WorkBreakdown): number {
  let total = 0;
  for (const feature of breakdown.features) {
    total += feature.epics.length;
  }
  return total;
}
