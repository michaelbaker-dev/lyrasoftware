/**
 * QA Runner — polls for tickets in "Code Review" status and spawns QA agents.
 * Parallel to the dispatcher — handles the QA phase of the ticket lifecycle.
 *
 * Flow:
 * 1. Poll Jira for "Code Review" tickets
 * 2. Find idle QA agent
 * 3. Create worktree from PR branch
 * 4. Spawn QA Claude Code agent
 * 5. On completion, run quality gate
 * 6. If passes → transition to "QA Passed", approve PR merge
 * 7. If fails → transition back to "To Do" with failure notes
 */

import { spawn, type ChildProcess } from "child_process";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { searchIssues, transitionIssue, addComment, getTransitions } from "./jira";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import { runQualityGate } from "./quality-gate";
import { enableAutoMerge } from "./github";
import { STORY_DOD } from "./dod";
import { getResolvedModel, resolveClaudeModel } from "./team-templates";
import { parseClaudeCodeOutput, trackUsage } from "./cost-tracker";
import { triggerDispatch } from "./dispatcher";

const exec = promisify(execFile);

// ── State ───────────────────────────────────────────────────────────

interface QaProcess {
  ticketKey: string;
  projectId: string;
  sessionId: string;
  worktreePath: string;
  branch: string;
  process: ChildProcess;
  startedAt: Date;
  output: string[];
}

// Persist state across Next.js HMR reloads
const globalForQa = globalThis as unknown as {
  __qaRunnerState: { activeQa: Map<string, QaProcess>; running: boolean; timer: ReturnType<typeof setInterval> | null } | undefined;
};

const qaState = globalForQa.__qaRunnerState ?? {
  activeQa: new Map<string, QaProcess>(),
  running: false,
  timer: null as ReturnType<typeof setInterval> | null,
};

if (process.env.NODE_ENV !== "production") {
  globalForQa.__qaRunnerState = qaState;
}

export function getQaState() {
  return {
    running: qaState.running,
    activeCount: qaState.activeQa.size,
    agents: Array.from(qaState.activeQa.values()).map((a) => ({
      ticketKey: a.ticketKey,
      branch: a.branch,
      startedAt: a.startedAt,
    })),
  };
}

// ── Start / Stop ────────────────────────────────────────────────────

export function startQaRunner(pollInterval: number = 15 * 60 * 1000) {
  if (qaState.running) return;
  qaState.running = true;
  console.log("[QA Runner] Started — polling every", pollInterval / 1000, "s");
  pollAndAssign();
  qaState.timer = setInterval(pollAndAssign, pollInterval);
}

export function stopQaRunner() {
  qaState.running = false;
  if (qaState.timer) {
    clearInterval(qaState.timer);
    qaState.timer = null;
  }
  console.log("[QA Runner] Stopped");
}

// ── Poll for Code Review tickets ────────────────────────────────────

async function pollAndAssign() {
  if (!qaState.running) return;

  try {
    const projects = await prisma.project.findMany({
      where: { status: "active" },
    });

    for (const project of projects) {
      // Find tickets in Code Review status
      const jql = `project = ${project.jiraKey} AND status = "Code Review" ORDER BY rank ASC`;
      const results = await searchIssues(jql);
      const tickets = results.issues || [];

      for (const ticket of tickets) {
        if (qaState.activeQa.has(ticket.key)) continue;

        // Find QA team, then find an idle QA agent (team-scoped first, then project-wide fallback)
        const qaTeam = await prisma.team.findFirst({
          where: { projectId: project.id, specialization: "qa", enabled: true },
        });

        const qaAgent = await prisma.agent.findFirst({
          where: {
            projectId: project.id,
            role: "qa",
            status: "idle",
            ...(qaTeam ? { teamId: qaTeam.id } : {}),
          },
          include: { team: true },
        }) ?? await prisma.agent.findFirst({
          where: { projectId: project.id, role: "qa", status: "idle" },
          include: { team: true },
        });

        if (!qaAgent) {
          console.log(`[QA Runner] No idle QA agent for ${project.jiraKey}`);
          break;
        }

        await assignQaAgent(
          ticket.key,
          project.id,
          project.path,
          project.jiraKey,
          ticket.fields.summary,
          ticket.fields.description,
          qaAgent,
          (project as { baseBranch?: string }).baseBranch || "main"
        );
      }
    }
  } catch (error) {
    console.error("[QA Runner] Poll error:", error);
  }
}

// ── Extract acceptance criteria (same logic as dispatcher) ──────────

function extractAcceptanceCriteria(description: unknown): string[] {
  if (!description) return [];

  let text = "";
  if (typeof description === "object" && description !== null) {
    const adf = description as {
      content?: Array<{ content?: Array<{ text?: string }> }>;
    };
    text =
      adf.content
        ?.map(
          (block) => block.content?.map((c) => c.text || "").join("") || ""
        )
        .join("\n") || "";
  } else if (typeof description === "string") {
    text = description;
  }

  const criteria: string[] = [];
  const lines = text.split("\n");
  let inCriteria = false;

  for (const line of lines) {
    if (/\*\*Acceptance Criteria:?\*\*/.test(line) || /^Acceptance Criteria:?\s*$/i.test(line.trim())) {
      inCriteria = true;
      continue;
    }
    if (inCriteria) {
      const match = line.match(/^[-*]\s*(?:\[[ x]?\]\s*)?(.+)/);
      if (match) {
        criteria.push(match[1].trim());
      } else if (line.match(/^\*\*/)) {
        break;
      }
    }
  }

  return criteria;
}

// ── Assign QA agent to ticket ───────────────────────────────────────

async function assignQaAgent(
  ticketKey: string,
  projectId: string,
  projectPath: string,
  projectKey: string,
  summary: string,
  description: unknown,
  agent: { id: string; name: string; model?: string | null; personality?: string | null; team?: { id: string; systemPrompt: string | null; model: string } | null },
  baseBranch: string
) {
  // Find the dev session to get the branch name
  const devSession = await prisma.session.findFirst({
    where: { ticketKey, projectId, status: "completed" },
    orderBy: { completedAt: "desc" },
  });

  if (!devSession) {
    console.log(`[QA Runner] No completed dev session for ${ticketKey}`);
    return;
  }

  const branch = devSession.branch;
  const worktreeDir = join(projectPath, "worktrees");
  const worktreePath = join(worktreeDir, `qa-${ticketKey}`);

  try {
    mkdirSync(worktreeDir, { recursive: true });

    // Create worktree from the dev branch
    if (!existsSync(worktreePath)) {
      await exec("git", ["worktree", "add", worktreePath, branch], {
        cwd: projectPath,
      });
    }
  } catch (error) {
    console.error(
      `[QA Runner] Failed to create worktree for ${ticketKey}:`,
      error
    );
    return;
  }

  const acceptanceCriteria = extractAcceptanceCriteria(description);

  // Create session
  const session = await prisma.session.create({
    data: {
      agentId: agent.id,
      projectId,
      ticketKey,
      branch: `qa/${ticketKey}`,
      worktreePath,
      status: "running",
    },
  });

  // Update agent status
  await prisma.agent.update({
    where: { id: agent.id },
    data: { status: "running", currentTicket: ticketKey, startedAt: new Date() },
  });

  // Get diff for context
  let diff = "";
  try {
    const { stdout } = await exec("git", ["diff", `${baseBranch}..HEAD`], {
      cwd: worktreePath,
    });
    diff = stdout.slice(0, 10000);
  } catch {
    diff = "(diff unavailable)";
  }

  const teamPromptSection = agent.team?.systemPrompt
    ? `${agent.team.systemPrompt}\n\n`
    : "";
  const personalityMod = agent.personality
    ? `\n\nPersonality: ${agent.personality}\n`
    : "";

  const prompt = `${teamPromptSection}You are a QA agent. Your job is to write comprehensive tests for the changes on this branch and verify all acceptance criteria.${personalityMod}

Ticket: ${ticketKey}: ${summary}

## Acceptance Criteria
${acceptanceCriteria.map((c) => `- [ ] ${c}`).join("\n") || "None specified — verify the implementation is correct and well-tested."}

## Code Changes (diff summary)
${diff.slice(0, 6000)}

## Your Tasks
1. Review the code changes thoroughly
2. Write comprehensive tests (unit tests, edge cases, integration tests where applicable)
3. Run all tests and verify they pass
4. Verify each acceptance criterion is met by the implementation
5. If you find bugs or unmet criteria, document them clearly

## Definition of Done
${STORY_DOD.map((d) => `- [ ] ${d}`).join("\n")}

Commit with format: test(${ticketKey}): description`;

  // Resolve team/agent model to a valid Claude CLI model flag
  const resolvedModel = agent.team ? getResolvedModel(agent, agent.team) : "claude-code/sonnet";
  const resolved = resolveClaudeModel(resolvedModel);

  // Fill in LM Studio URL for local models
  if (resolved.envOverrides?.ANTHROPIC_BASE_URL === "") {
    const lmUrlSetting = await prisma.setting.findUnique({ where: { key: "lm_studio_url" } });
    resolved.envOverrides.ANTHROPIC_BASE_URL = lmUrlSetting?.value || "http://192.168.56.203:1234";
  }

  const { model: claudeModel, isNative } = resolved;
  if (!isNative) {
    console.log(`[QA Runner] Team model "${resolvedModel}" not a Claude model — using ${claudeModel} for ${ticketKey}`);
  }

  // Strip CLAUDECODE env var so spawned agents don't think they're nested sessions
  const cleanEnv = { ...process.env };
  delete cleanEnv.CLAUDECODE;

  // Inject env overrides (e.g. ANTHROPIC_BASE_URL for LM Studio local models)
  if (resolved.envOverrides) {
    Object.assign(cleanEnv, resolved.envOverrides);
  }

  const child = spawn(
    "claude",
    ["-p", prompt, "--model", claudeModel, "--dangerously-skip-permissions", "--output-format", "stream-json", "--verbose"],
    {
      cwd: worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
      env: cleanEnv,
    }
  );

  const qaProcess: QaProcess = {
    ticketKey,
    projectId,
    sessionId: session.id,
    worktreePath,
    branch,
    process: child,
    startedAt: new Date(),
    output: [],
  };

  qaState.activeQa.set(ticketKey, qaProcess);

  lyraEvents.emit("qa:assigned", {
    ticketKey,
    projectId,
    agentName: agent.name,
    prBranch: branch,
  });

  await addComment(ticketKey, `QA agent ${agent.name} assigned for testing.`);

  // Collect output
  child.stdout?.on("data", (data: Buffer) => {
    qaProcess.output.push(data.toString());
  });
  child.stderr?.on("data", (data: Buffer) => {
    qaProcess.output.push(data.toString());
  });

  // Handle completion
  child.on("close", async (code) => {
    qaState.activeQa.delete(ticketKey);

    const status = code === 0 ? "completed" : "failed";
    const rawOutput = qaProcess.output.join("");

    // Parse Claude Code stream-json output for cost/token data
    const parsedCost = parseClaudeCodeOutput(rawOutput);

    await prisma.session.update({
      where: { id: session.id },
      data: {
        status,
        completedAt: new Date(),
        output: rawOutput,
        cost: parsedCost.cost,
        tokensUsed: parsedCost.totalTokens,
      },
    });

    // Track usage in AiUsageLog
    if (parsedCost.totalTokens > 0 || parsedCost.cost > 0) {
      try {
        await trackUsage({
          projectId,
          sessionId: session.id,
          agentId: agent.id,
          teamId: agent.team?.id,
          category: "qa",
          ticketKey,
          provider: "anthropic",
          requestedModel: agent.team ? getResolvedModel(agent, agent.team) : "claude-sonnet-4-5",
          actualModel: agent.team ? getResolvedModel(agent, agent.team) : "claude-sonnet-4-5",
          promptTokens: parsedCost.promptTokens,
          completionTokens: parsedCost.completionTokens,
          totalTokens: parsedCost.totalTokens,
          cost: parsedCost.cost,
          durationMs: Date.now() - qaProcess.startedAt.getTime(),
        });
      } catch (e) {
        console.error("[QA Runner] Cost tracking failed (non-fatal):", e);
      }
    }

    await prisma.agent.update({
      where: { id: agent.id },
      data: { status: "idle", currentTicket: null, startedAt: null },
    });

    if (code === 0) {
      // Run quality gate on QA results
      const gateResult = await runQualityGate({
        sessionId: session.id,
        ticketKey,
        projectId,
        worktreePath,
        baseBranch,
        acceptanceCriteria,
        agentOutput: qaProcess.output.join(""),
        summary,
      });

      if (gateResult.passed) {
        // QA passed — transition to QA Passed, approve PR
        lyraEvents.emit("qa:passed", {
          ticketKey,
          projectId,
          sessionId: session.id,
          passed: true,
          details: gateResult.reasoning,
        });

        // Transition to QA Passed — fall back to Done for simple Jira workflows
        const qaPassed = await transitionToStatus(ticketKey, "QA Passed");
        if (!qaPassed) {
          await transitionToStatus(ticketKey, "Done");
        }
        await addComment(
          ticketKey,
          [
            "h3. QA Passed",
            `QA agent completed successfully. Quality gate: PASSED`,
            "",
            `Reasoning: ${gateResult.reasoning}`,
            "",
            "Checks:",
            ...gateResult.checks.map(
              (c) => `* ${c.passed ? "(/)" : "(x)"} ${c.name}: ${c.details.slice(0, 200)}`
            ),
          ].join("\n")
        );

        // Approve PR merge
        const project = await prisma.project.findUnique({
          where: { id: projectId },
        });
        if (project?.githubRepo) {
          try {
            // Find PR number from branch
            const { stdout } = await exec("gh", [
              "pr", "list",
              "--repo", `michaelbaker-dev/${project.githubRepo}`,
              "--head", branch,
              "--json", "number",
              "--limit", "1",
            ]);
            const prs = JSON.parse(stdout);
            if (prs.length > 0) {
              await enableAutoMerge(project.githubRepo, prs[0].number);
              lyraEvents.emit("pr:approved", {
                ticketKey,
                projectId,
                prUrl: `https://github.com/michaelbaker-dev/${project.githubRepo}/pull/${prs[0].number}`,
              });
            }
          } catch (e) {
            console.error(`[QA Runner] PR merge error for ${ticketKey}:`, e);
          }
        }
      } else {
        // QA gate failed — send back to To Do
        lyraEvents.emit("qa:failed", {
          ticketKey,
          projectId,
          sessionId: session.id,
          passed: false,
          details: gateResult.reasoning,
        });

        await transitionToStatus(ticketKey, "To Do");
        await addComment(
          ticketKey,
          [
            "h3. QA Failed — Sent Back for Rework",
            "",
            `Reasoning: ${gateResult.reasoning}`,
            "",
            "Failed checks:",
            ...gateResult.checks
              .filter((c) => !c.passed)
              .map((c) => `* (x) ${c.name}: ${c.details.slice(0, 300)}`),
          ].join("\n")
        );
      }
    } else {
      // QA agent crashed
      lyraEvents.emit("qa:failed", {
        ticketKey,
        projectId,
        sessionId: session.id,
        passed: false,
        details: `QA agent exited with code ${code}`,
      });

      await addComment(
        ticketKey,
        `QA agent exited with code ${code}. Sending back for rework.`
      );
      await transitionToStatus(ticketKey, "To Do");
    }

    await prisma.auditLog.create({
      data: {
        projectId,
        action: `qa.${status}`,
        actor: agent.name,
        details: JSON.stringify({ ticketKey, code }),
      },
    });

    // QA finished — reactively trigger dispatcher to pick up new dev work
    setTimeout(() => triggerDispatch(), 2000);
  });
}

// ── Helper: transition ticket to a named status ─────────────────────

async function transitionToStatus(
  ticketKey: string,
  targetStatus: string
): Promise<boolean> {
  try {
    const { transitions } = await getTransitions(ticketKey);
    const target = transitions?.find(
      (t: { name: string }) =>
        t.name.toLowerCase() === targetStatus.toLowerCase()
    );
    if (!target) {
      console.warn(`[QA Runner] No transition matching "${targetStatus}" for ${ticketKey}`);
      return false;
    }
    await transitionIssue(ticketKey, target.id);
    return true;
  } catch (e) {
    console.error(`[QA Runner] Transition error for ${ticketKey}:`, e);
    return false;
  }
}
