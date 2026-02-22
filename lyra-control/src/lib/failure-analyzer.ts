/**
 * Failure Analyzer & Auto-Triage — LLM-powered failure classification,
 * fix suggestions, and automated Jira actions (bug creation, reassignment, escalation).
 */

import { chat, type ChatMessage } from "./openrouter";
import { isClaudeCodeModel, chatViaClaude } from "./claude-code-chat";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import {
  addComment,
  createIssue,
  linkIssues,
  updateIssueFields,
  searchIssues,
  getBoardsForProject,
  getSprints,
  moveIssuesToSprint,
} from "./jira";
import { transitionToStatus } from "./dispatcher";

// ── Types ─────────────────────────────────────────────────────────────

export type FailureCategory =
  | "build_error"
  | "test_failure"
  | "runtime_crash"
  | "type_error"
  | "lint_failure"
  | "env_issue"
  | "dependency_issue"
  | "timeout"
  | "unknown";

export type TriageAction =
  | "retry_same_team"
  | "reassign"
  | "create_bug"
  | "block_ticket"
  | "escalate";

export interface FailureAnalysis {
  category: FailureCategory;
  action: TriageAction;
  summary: string;
  suggestedFix: string;
  confidence: number;
  reassignTo?: string;
  rootCause?: string;
}

export interface TriageInput {
  projectId: string;
  ticketKey: string;
  ticketSummary: string;
  ticketDescription?: string;
  sessionOutput?: string;
  sessionId?: string;
  gateDetails?: string;
  attemptCount: number;
  teamLabels?: string[];
  forcedAction?: TriageAction;
  source?: string;
}

// ── Upsert helper (dedup) ────────────────────────────────────────────

export async function upsertTriageLog(data: {
  projectId: string;
  ticketKey: string;
  ticketSummary?: string;
  sessionId?: string;
  source: string;
  category: string;
  action: string;
  summary: string;
  suggestedFix: string;
  rootCause?: string | null;
  confidence: number;
  reassignTo?: string | null;
  actionTaken: string;
  linkedBugKey?: string | null;
  resolution: string;
  attemptCount: number;
}) {
  // Look for existing non-terminal entry on (projectId, ticketKey)
  const existing = await prisma.triageLog.findFirst({
    where: {
      projectId: data.projectId,
      ticketKey: data.ticketKey,
      resolution: { notIn: ["fixed", "wontfix"] },
    },
    orderBy: { createdAt: "desc" },
  });

  if (existing) {
    return prisma.triageLog.update({
      where: { id: existing.id },
      data: {
        sessionId: data.sessionId ?? existing.sessionId,
        ticketSummary: data.ticketSummary ?? existing.ticketSummary,
        source: data.source,
        category: data.category,
        action: data.action,
        summary: data.summary,
        suggestedFix: data.suggestedFix,
        rootCause: data.rootCause,
        confidence: data.confidence,
        reassignTo: data.reassignTo,
        actionTaken: data.actionTaken,
        linkedBugKey: data.linkedBugKey ?? existing.linkedBugKey,
        resolution: data.resolution,
        attemptCount: existing.attemptCount + 1,
      },
    });
  }

  return prisma.triageLog.create({
    data: {
      projectId: data.projectId,
      ticketKey: data.ticketKey,
      ticketSummary: data.ticketSummary,
      sessionId: data.sessionId,
      source: data.source,
      category: data.category,
      action: data.action,
      summary: data.summary,
      suggestedFix: data.suggestedFix,
      rootCause: data.rootCause,
      confidence: data.confidence,
      reassignTo: data.reassignTo,
      actionTaken: data.actionTaken,
      linkedBugKey: data.linkedBugKey,
      resolution: data.resolution,
      attemptCount: data.attemptCount,
    },
  });
}

// ── Model resolution ──────────────────────────────────────────────────

async function getTriageModel(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "model_triage" },
  });
  return setting?.value || "openrouter/auto";
}

// ── LLM Analysis ──────────────────────────────────────────────────────

export async function analyzeFailure(input: TriageInput): Promise<FailureAnalysis> {
  const model = await getTriageModel();

  const outputTail = input.sessionOutput
    ? input.sessionOutput.slice(-8000)
    : "(no session output available)";

  const teamSection = input.teamLabels?.length
    ? `Available teams: ${input.teamLabels.join(", ")}`
    : "No team labels available.";

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are a failure triage system for an AI-driven development platform.
Analyze the failed agent session and classify the failure. Respond with ONLY valid JSON matching this schema:

{
  "category": "build_error" | "test_failure" | "runtime_crash" | "type_error" | "lint_failure" | "env_issue" | "dependency_issue" | "timeout" | "unknown",
  "action": "retry_same_team" | "reassign" | "create_bug" | "block_ticket" | "escalate",
  "summary": "1-2 sentence human-readable summary",
  "suggestedFix": "actionable advice for the dev team",
  "confidence": 0.0 to 1.0,
  "reassignTo": "team label if action is reassign, otherwise omit",
  "rootCause": "best-guess root cause"
}

Guidelines for action selection:
- retry_same_team: Simple/transient issues, first 1-2 failures, clear fix path
- reassign: Problem requires a different specialization (e.g., infra vs feature)
- create_bug: Persistent issue (3+ attempts), underlying bug in existing code
- block_ticket: Cannot proceed without human input (missing requirements, API access, etc.)
- escalate: Critical issue needing Product Owner attention (repeated failures, architectural problem)

${teamSection}`,
    },
    {
      role: "user",
      content: `Ticket: ${input.ticketKey}: ${input.ticketSummary}
${input.ticketDescription ? `Description: ${input.ticketDescription}` : ""}
${input.gateDetails ? `Quality gate details: ${input.gateDetails}` : ""}
Attempt #${input.attemptCount}

Session output (last lines):
\`\`\`
${outputTail}
\`\`\``,
    },
  ];

  let content: string;
  if (isClaudeCodeModel(model)) {
    const result = await chatViaClaude(messages, model);
    content = result.content || "{}";
  } else {
    const response = await chat(messages, model, {
      projectId: input.projectId,
      ticketKey: input.ticketKey,
      category: "triage",
    });
    content = response.choices[0]?.message?.content || "{}";
  }

  try {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch?.[0] || content);

    return {
      category: parsed.category || "unknown",
      action: parsed.action || "retry_same_team",
      summary: parsed.summary || "Analysis failed to produce a summary.",
      suggestedFix: parsed.suggestedFix || "No suggestion available.",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reassignTo: parsed.reassignTo,
      rootCause: parsed.rootCause,
    };
  } catch {
    console.error("[FailureAnalyzer] Failed to parse LLM response:", content.slice(0, 500));
    return {
      category: "unknown",
      action: "retry_same_team",
      summary: "Triage analysis failed to parse. Defaulting to retry.",
      suggestedFix: "Review the session output manually.",
      confidence: 0.1,
    };
  }
}

// ── Full triage orchestration ─────────────────────────────────────────

export async function triageAndActOnFailure(input: TriageInput): Promise<FailureAnalysis> {
  const analysis = await analyzeFailure(input);

  // Override action if forced (e.g., from oversight escalation)
  if (input.forcedAction) {
    analysis.action = input.forcedAction;
  }

  let actionTaken = "";
  let linkedBugKey: string | null = null;

  try {
    switch (analysis.action) {
      case "retry_same_team": {
        // Inject triage note into a comment for the next agent to see
        await addComment(
          input.ticketKey,
          `[TRIAGE NOTE] ${analysis.summary}\n\nSuggested fix: ${analysis.suggestedFix}${analysis.rootCause ? `\nRoot cause: ${analysis.rootCause}` : ""}`
        );
        await transitionToStatus(input.ticketKey, "To Do");
        actionTaken = "Added triage note, returned to To Do for retry";
        break;
      }

      case "reassign": {
        if (analysis.reassignTo) {
          await updateIssueFields(input.ticketKey, {
            labels: [analysis.reassignTo],
          });
        }
        await addComment(
          input.ticketKey,
          `[TRIAGE] Reassigning to ${analysis.reassignTo || "different team"}.\n\n${analysis.summary}\nSuggested fix: ${analysis.suggestedFix}`
        );
        await transitionToStatus(input.ticketKey, "To Do");
        actionTaken = `Reassigned to ${analysis.reassignTo || "different team"}, returned to To Do`;
        break;
      }

      case "create_bug": {
        // Extract project key from ticket key (e.g., "HELLO-32" → "HELLO")
        const projectKey = input.ticketKey.split("-")[0];

        const bugResult = await createIssue(
          projectKey,
          "Bug",
          `[Auto-triage] ${analysis.summary}`,
          `Root cause: ${analysis.rootCause || "Unknown"}\n\nSuggested fix: ${analysis.suggestedFix}\n\nOriginated from: ${input.ticketKey}\nFailure category: ${analysis.category}\nAttempt count: ${input.attemptCount}`
        );

        linkedBugKey = bugResult?.key || null;

        // Link bug to original story with "Relates" (not "Blocks") to avoid
        // deadlocking the dispatcher — the bug is informational, not a gate.
        if (bugResult?.key) {
          await linkIssues(bugResult.key, input.ticketKey, "Relates").catch((e) =>
            console.error(`[FailureAnalyzer] Failed to link ${bugResult.key} to ${input.ticketKey}:`, e)
          );
        }

        // Return original to To Do so the dispatcher can retry it
        await transitionToStatus(input.ticketKey, "To Do").catch(() =>
          addComment(input.ticketKey, `Bug ${bugResult?.key} created for underlying issue. Returning to To Do for retry.`)
        );

        actionTaken = `Created bug ${bugResult?.key || "?"}, linked to ${input.ticketKey}, original blocked`;
        break;
      }

      case "block_ticket": {
        await addComment(
          input.ticketKey,
          `[TRIAGE] Ticket blocked — requires human intervention.\n\n${analysis.summary}\nReason: ${analysis.rootCause || analysis.suggestedFix}`
        );
        await transitionToStatus(input.ticketKey, "Blocked").catch(() =>
          addComment(input.ticketKey, "Status: Blocked (manual transition needed)")
        );
        actionTaken = "Ticket blocked, awaiting human intervention";
        break;
      }

      case "escalate": {
        await addComment(
          input.ticketKey,
          `[ESCALATION] Requires Product Owner attention.\n\n${analysis.summary}\nRoot cause: ${analysis.rootCause || "Unknown"}\nSuggested fix: ${analysis.suggestedFix}`
        );
        await transitionToStatus(input.ticketKey, "Blocked").catch(() =>
          addComment(input.ticketKey, "Status: Blocked (escalated)")
        );
        actionTaken = "Escalated to Product Owner, ticket blocked";
        break;
      }
    }
  } catch (e) {
    console.error(`[FailureAnalyzer] Action execution error for ${input.ticketKey}:`, e);
    actionTaken = `Action failed: ${(e as Error).message}`;
  }

  // Cascade notification for blocking actions — notify dependents waiting on this ticket
  if (["create_bug", "block_ticket", "escalate"].includes(analysis.action)) {
    try {
      const { extractDependencies } = await import("./jira");
      const projectKey = input.ticketKey.split("-")[0];
      const jql = `project = ${projectKey} AND status = "To Do" ORDER BY rank ASC`;
      const results = await searchIssues(jql, 100);

      const blockedKeys: string[] = [];
      for (const issue of results.issues || []) {
        const deps = extractDependencies(issue);
        if (deps.some((d) => d.type === "is-blocked-by" && d.key === input.ticketKey)) {
          blockedKeys.push(issue.key);
        }
      }

      if (blockedKeys.length > 0) {
        lyraEvents.emit("notify", {
          projectId: input.projectId,
          severity: "warning",
          title: `Blocked ticket has dependents: ${input.ticketKey}`,
          body: `${input.ticketKey} was ${analysis.action === "create_bug" ? "blocked by a bug" : analysis.action === "escalate" ? "escalated" : "blocked"}. Waiting tickets: ${blockedKeys.join(", ")}`,
        });
      }
    } catch { /* non-fatal */ }
  }

  // Persist triage log
  try {
    const resolution =
      analysis.action === "retry_same_team" || analysis.action === "reassign"
        ? "retrying"
        : analysis.action === "escalate"
          ? "escalated"
          : "open";

    await upsertTriageLog({
      projectId: input.projectId,
      ticketKey: input.ticketKey,
      ticketSummary: input.ticketSummary,
      sessionId: input.sessionId,
      source: input.source || "agent_failure",
      category: analysis.category,
      action: analysis.action,
      summary: analysis.summary,
      suggestedFix: analysis.suggestedFix,
      rootCause: analysis.rootCause,
      confidence: analysis.confidence,
      reassignTo: analysis.reassignTo,
      actionTaken,
      linkedBugKey,
      resolution,
      attemptCount: input.attemptCount,
    });
  } catch (e) {
    console.error("[FailureAnalyzer] Failed to persist triage log:", e);
  }

  // Emit event
  lyraEvents.emit("failure:analyzed", {
    projectId: input.projectId,
    ticketKey: input.ticketKey,
    analysis: {
      category: analysis.category,
      action: analysis.action,
      summary: analysis.summary,
      suggestedFix: analysis.suggestedFix,
      confidence: analysis.confidence,
      reassignTo: analysis.reassignTo,
      rootCause: analysis.rootCause,
    },
    actionTaken,
  });

  return analysis;
}

// ── Lyra Smart Retry — targeted prompt generation ─────────────────────

export async function generateSmartRetryPrompt(input: {
  projectId: string;
  ticketKey: string;
  ticketSummary: string;
  ticketDescription?: string;
  sessionOutput: string;
  gateChecks: { name: string; passed: boolean; details: string }[];
  gateReasoning: string;
  acceptanceCriteria: string[];
  worktreePath: string;
  baseBranch: string;
  assignedRole: string;
  attemptCount: number;
}): Promise<string | null> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const exec = promisify(execFile);

  // Gather git diff from the worktree (what the agent produced)
  let gitDiff = "";
  try {
    const { stdout } = await exec("git", ["diff", `${input.baseBranch}..HEAD`], {
      cwd: input.worktreePath,
      maxBuffer: 100_000,
    });
    gitDiff = stdout.slice(0, 8000);
  } catch {
    gitDiff = "(no diff available)";
  }

  // Get file listing of the worktree
  let fileListing = "";
  try {
    const { stdout } = await exec("find", [".", "-type", "f", "-not", "-path", "./.git/*", "-not", "-path", "./node_modules/*"], {
      cwd: input.worktreePath,
      maxBuffer: 50_000,
    });
    fileListing = stdout.slice(0, 3000);
  } catch {
    fileListing = "(file listing unavailable)";
  }

  // Get git log to see what commits exist
  let gitLog = "";
  try {
    const { stdout } = await exec("git", ["log", `${input.baseBranch}..HEAD`, "--oneline"], {
      cwd: input.worktreePath,
    });
    gitLog = stdout.trim() || "(no commits on branch)";
  } catch {
    gitLog = "(git log unavailable)";
  }

  // Load previous session outputs for context (last 2)
  let previousSessions = "";
  try {
    const sessions = await prisma.session.findMany({
      where: { ticketKey: input.ticketKey, projectId: input.projectId },
      orderBy: { createdAt: "desc" },
      take: 2,
      select: { id: true, output: true, status: true, createdAt: true },
    });
    previousSessions = sessions
      .map((s) => `Session ${s.id} (${s.status}, ${s.createdAt.toISOString()}):\n${(s.output || "").slice(-2000)}`)
      .join("\n\n---\n\n");
  } catch {
    previousSessions = "(no previous sessions found)";
  }

  // Load Jira comments for PO instructions and triage notes
  let jiraComments = "";
  try {
    const { getIssue } = await import("./jira");
    const issue = await getIssue(input.ticketKey);
    const comments = issue.fields?.comment?.comments || [];
    jiraComments = comments
      .slice(-5) // last 5 comments
      .map((c: { body: unknown; author?: { displayName?: string } }) => {
        const body = typeof c.body === "string" ? c.body : JSON.stringify(c.body).slice(0, 500);
        return `${c.author?.displayName || "Unknown"}: ${body}`;
      })
      .join("\n\n");
  } catch {
    jiraComments = "(no comments available)";
  }

  // Build the quality gate results summary
  const gateResults = input.gateChecks
    .map((c) => `${c.passed ? "PASSED" : "FAILED"}: ${c.name} — ${c.details.slice(0, 300)}`)
    .join("\n");

  const acList = input.acceptanceCriteria.length > 0
    ? input.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`).join("\n")
    : "(no acceptance criteria defined)";

  // Call Lyra's brain with a comprehensive prompt
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: `You are Lyra, the AI Scrum Master and lead technical advisor. An agent just failed the quality gate for a ticket. Your job is to generate a COMPLETE, SELF-CONTAINED agent prompt that will fix the specific failures and get this ticket to pass the quality gate.

You must be extremely specific and actionable. The agent receiving your prompt has NO other context — your prompt is all they get (plus the standard role preamble and project CLAUDE.md).

Structure your response as a direct instruction prompt for the agent. Do NOT include any meta-commentary or explanation for the human — write ONLY the agent prompt.`,
    },
    {
      role: "user",
      content: `## Ticket: ${input.ticketKey}
Summary: ${input.ticketSummary}
${input.ticketDescription ? `Description: ${input.ticketDescription}` : ""}
Role: ${input.assignedRole}
Attempt: ${input.attemptCount + 1}

## Acceptance Criteria
${acList}

## Quality Gate Results (from last attempt)
${gateResults}
Reasoning: ${input.gateReasoning}

## Git State
Commits on branch:
${gitLog}

Diff (what the agent produced):
\`\`\`
${gitDiff}
\`\`\`

## Files in Worktree
\`\`\`
${fileListing}
\`\`\`

## Previous Agent Output (what they claimed)
${input.sessionOutput.slice(-4000)}

## Jira Comments (includes PO instructions and triage notes)
${jiraComments}

## Previous Session History
${previousSessions.slice(0, 3000)}

---

Generate the agent prompt. Be specific:
- List exactly which files need to be created or modified
- Show the exact verification commands (build, test, type-check) to run
- Address each FAILED quality gate check explicitly with the fix
- If files exist but aren't committed, tell the agent to git add and commit them
- If the approach was wrong, explain the correct approach
- Include the acceptance criteria with specific verification steps
- Tell the agent to run git status and git diff --stat before finishing
- Remind them that ALL work must be committed — the quality gate evaluates the git diff`,
    },
  ];

  try {
    const response = await chat(
      messages,
      "anthropic/claude-haiku-4-5-20251001",
      { projectId: input.projectId, ticketKey: input.ticketKey, category: "smart_retry" }
    );
    const prompt = response.choices[0]?.message?.content;
    if (prompt && prompt.length > 100) {
      console.log(`[SmartRetry] Generated ${prompt.length}-char targeted prompt for ${input.ticketKey}`);
      return prompt;
    }
    console.warn(`[SmartRetry] Generated prompt too short for ${input.ticketKey}, falling back to standard`);
    return null;
  } catch (e) {
    console.error(`[SmartRetry] Failed to generate prompt for ${input.ticketKey}:`, e);
    return null;
  }
}

// ── Slack bug report triage ───────────────────────────────────────────

export async function triageSlackBug(input: {
  issueKey: string;
  projectId?: string;
}): Promise<FailureAnalysis | null> {
  try {
    // Fetch the bug ticket from Jira
    const { getIssue } = await import("./jira");
    const issue = await getIssue(input.issueKey);
    const summary = issue.fields?.summary || "";
    const description = issue.fields?.description?.content?.[0]?.content?.[0]?.text || "";
    const projectKey = input.issueKey.split("-")[0];

    // Find project in DB
    const project = input.projectId
      ? await prisma.project.findUnique({ where: { id: input.projectId } })
      : await prisma.project.findFirst({ where: { jiraKey: projectKey } });

    if (!project) {
      console.warn(`[FailureAnalyzer] No project found for ${input.issueKey}`);
      return null;
    }

    // Load team labels
    const teams = await prisma.team.findMany({
      where: { projectId: project.id, enabled: true },
      select: { name: true },
    });

    // Analyze the bug
    const analysis = await analyzeFailure({
      projectId: project.id,
      ticketKey: input.issueKey,
      ticketSummary: summary,
      ticketDescription: description,
      attemptCount: 0,
      teamLabels: teams.map((t) => t.name),
    });

    // Enrich the Jira ticket with triage analysis
    await addComment(
      input.issueKey,
      `[AUTO-TRIAGE] Category: ${analysis.category}\nRoot cause: ${analysis.rootCause || "Unknown"}\nSuggested fix: ${analysis.suggestedFix}\nConfidence: ${Math.round(analysis.confidence * 100)}%`
    );

    // Assign to the right team via labels
    if (analysis.reassignTo) {
      await updateIssueFields(input.issueKey, {
        labels: [analysis.reassignTo],
      }).catch(() => {});
    }

    // If a sprint is active, add the bug to the current sprint
    if (project.activeSprintId) {
      try {
        await moveIssuesToSprint(project.activeSprintId, [input.issueKey]);
      } catch (e) {
        console.error(`[FailureAnalyzer] Failed to add ${input.issueKey} to sprint:`, e);
      }
    }

    // Persist triage log
    try {
      await upsertTriageLog({
        projectId: project.id,
        ticketKey: input.issueKey,
        ticketSummary: summary,
        source: "slack_bug",
        category: analysis.category,
        action: analysis.action,
        summary: analysis.summary,
        suggestedFix: analysis.suggestedFix,
        rootCause: analysis.rootCause,
        confidence: analysis.confidence,
        reassignTo: analysis.reassignTo,
        actionTaken: "Slack bug triaged and enriched",
        resolution: "open",
        attemptCount: 0,
      });
    } catch (e) {
      console.error("[FailureAnalyzer] Failed to persist slack triage log:", e);
    }

    // Emit event
    lyraEvents.emit("failure:analyzed", {
      projectId: project.id,
      ticketKey: input.issueKey,
      analysis: {
        category: analysis.category,
        action: analysis.action,
        summary: analysis.summary,
        suggestedFix: analysis.suggestedFix,
        confidence: analysis.confidence,
        reassignTo: analysis.reassignTo,
        rootCause: analysis.rootCause,
      },
      actionTaken: "Slack bug triaged and enriched",
    });

    return analysis;
  } catch (e) {
    console.error(`[FailureAnalyzer] triageSlackBug error for ${input.issueKey}:`, e);
    return null;
  }
}
