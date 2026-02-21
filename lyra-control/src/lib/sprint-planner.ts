/**
 * Sprint Planner — AI-assisted sprint planning, activation, and completion.
 * Uses Jira Agile API for sprint management and OpenRouter for AI story selection.
 */

import { chat } from "./openrouter";
import * as jira from "./jira";
import { prisma } from "./db";
import { startScheduler } from "./scheduler";
import { gatherDemoData } from "./sprint-demo-data";
import { generateReleaseNotes } from "./release-notes-generator";
import { getRoleNames, getAllRoles } from "./role-config";

// ── Plan Sprint ──────────────────────────────────────────────────────

export type SprintPlanResult = {
  sprint: {
    jiraSprintId: number;
    name: string;
    goal: string;
    selectedKeys: string[];
    plannedPoints: number;
    reasoning: string;
  };
  logs: string[];
};

export async function planSprint(data: {
  projectId: string;
  sprintName: string;
  goal?: string;
  model?: string;
}): Promise<SprintPlanResult> {
  const logs: string[] = [];

  const project = await prisma.project.findUnique({ where: { id: data.projectId } });
  if (!project) throw new Error("Project not found");
  if (!project.jiraBoardId) throw new Error("No Scrum board found — re-run Jira setup");

  // Fetch backlog
  logs.push("Fetching backlog from Jira...");
  const backlogResult = await jira.getBacklog(project.jiraBoardId);
  const backlogIssues = backlogResult.issues || [];
  logs.push(`Found ${backlogIssues.length} backlog issues`);

  if (backlogIssues.length === 0) {
    throw new Error("Backlog is empty — generate a work breakdown first");
  }

  // Get story points field
  const spField = await jira.getStoryPointsFieldId();

  // Build dynamic role regex from DB
  const roleNames = await getRoleNames();
  const rolePattern = new RegExp(`\\*\\*Assigned Role\\*\\*:\\s*(${roleNames.join("|")})`, "i");

  // Build story summaries for AI
  const storySummaries = backlogIssues.map((issue: jira.JiraIssue) => {
    const points = spField ? (issue.fields[spField] as number) || 0 : 0;
    const desc = issue.fields.description?.content
      ?.map((block: { content?: Array<{ text?: string }> }) =>
        block.content?.map((c: { text?: string }) => c.text).join("") || ""
      )
      .join("\n") || "";

    // Extract role from description
    const roleMatch = desc.match(rolePattern);
    const role = roleMatch?.[1] || "dev";

    // Extract dependencies
    const deps = jira.extractDependencies(issue);
    const blockedBy = deps.filter((d) => d.type === "is-blocked-by").map((d) => d.key);
    const blocks = deps.filter((d) => d.type === "blocks").map((d) => d.key);

    return {
      key: issue.key,
      type: issue.fields.issuetype.name,
      summary: issue.fields.summary,
      points,
      role,
      blockedBy,
      blocks,
    };
  });

  // Ask AI to select stories
  logs.push(`Asking AI to plan sprint (velocity target: ${project.velocityTarget} points)...`);

  const aiResponse = await chat(
    [
      {
        role: "system",
        content: `You are a scrum master planning a sprint. Select stories from the backlog to fill a sprint.

Rules:
- Target velocity: ${project.velocityTarget} story points (do not exceed by more than 3 points)
- Prioritize architect stories before dev stories, and dev stories before QA stories within the same epic
- Include related QA stories when selecting dev stories from the same epic
- Respect dependencies: if story A is blocked by story B, include B in the sprint too (or ensure B is already done)
- Do NOT include a story without also including its blockers (unless the blocker is already completed)
- Return JSON only (no markdown fences):
{
  "selectedKeys": ["KEY-1", "KEY-2", ...],
  "reasoning": "Brief explanation of selection rationale"
}`,
      },
      {
        role: "user",
        content: `Sprint: ${data.sprintName}
Goal: ${data.goal || "Complete highest priority work"}
Velocity target: ${project.velocityTarget} points

Backlog:
${storySummaries.map((s: { key: string; type: string; summary: string; points: number; role: string; blockedBy: string[]; blocks: string[] }) => {
  let line = `- ${s.key} [${s.type}] ${s.summary} (${s.points}pts, ${s.role})`;
  if (s.blockedBy.length > 0) line += ` [BLOCKED BY: ${s.blockedBy.join(", ")}]`;
  if (s.blocks.length > 0) line += ` [BLOCKS: ${s.blocks.join(", ")}]`;
  return line;
}).join("\n")}`,
      },
    ],
    data.model || "openrouter/auto",
    { projectId: data.projectId, category: "sprint-planning" }
  );

  const rawContent = aiResponse.choices[0]?.message?.content || "";
  let jsonStr = rawContent.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();

  const plan = JSON.parse(jsonStr) as { selectedKeys: string[]; reasoning: string };
  logs.push(`AI selected ${plan.selectedKeys.length} stories`);
  logs.push(`Reasoning: ${plan.reasoning}`);

  // Calculate planned points
  const plannedPoints = plan.selectedKeys.reduce((sum, key) => {
    const story = storySummaries.find((s: { key: string }) => s.key === key);
    return sum + (story?.points || 0);
  }, 0);
  logs.push(`Planned points: ${plannedPoints}`);

  // Create sprint in Jira
  const now = new Date();
  const endDate = new Date(now.getTime() + project.sprintLength * 24 * 60 * 60 * 1000);

  logs.push("Creating sprint in Jira...");
  const jiraSprint = await jira.createSprint({
    name: data.sprintName,
    startDate: now.toISOString(),
    endDate: endDate.toISOString(),
    originBoardId: project.jiraBoardId,
    goal: data.goal,
  });
  logs.push(`Sprint created: ${jiraSprint.name} (id: ${jiraSprint.id})`);

  // Move stories to sprint
  if (plan.selectedKeys.length > 0) {
    logs.push("Moving stories to sprint...");
    await jira.moveIssuesToSprint(jiraSprint.id, plan.selectedKeys);
    logs.push(`Moved ${plan.selectedKeys.length} stories to sprint`);
  }

  // Save sprint locally
  await prisma.sprint.create({
    data: {
      projectId: data.projectId,
      jiraSprintId: jiraSprint.id,
      name: data.sprintName,
      goal: data.goal || null,
      startDate: now,
      endDate,
      state: "future",
      plannedPoints,
    },
  });
  logs.push("Sprint saved to local database");

  return {
    sprint: {
      jiraSprintId: jiraSprint.id,
      name: data.sprintName,
      goal: data.goal || "",
      selectedKeys: plan.selectedKeys,
      plannedPoints,
      reasoning: plan.reasoning,
    },
    logs,
  };
}

// ── Start Sprint ─────────────────────────────────────────────────────

export async function startSprint(sprintId: string): Promise<{ logs: string[] }> {
  const logs: string[] = [];

  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint) throw new Error("Sprint not found");

  // Pre-start gap analysis — block if critical gaps exist (no agents for required roles)
  const sprintIssues = await jira.getSprintIssues(sprint.jiraSprintId);
  const issueKeys = (sprintIssues.issues || []).map((i: { key: string }) => i.key);
  if (issueKeys.length > 0) {
    const gaps = await analyzeTeamGaps(sprint.projectId, issueKeys);
    const criticalGaps = gaps.filter((g) => g.severity === "critical");
    if (criticalGaps.length > 0) {
      const missing = criticalGaps.map((g) => `${g.label} (${g.storiesRequiring} stories, 0 agents)`).join(", ");
      throw new Error(
        `Cannot start sprint — missing agents for required roles: ${missing}. Add agents in Team Config first.`
      );
    }
    if (gaps.length > 0) {
      for (const gap of gaps) {
        logs.push(`WARNING: ${gap.label} may be understaffed — ${gap.storiesRequiring} stories, ${gap.agentsAvailable} agents`);
      }
    }
  }

  logs.push(`Activating sprint: ${sprint.name}`);
  await jira.updateSprint(sprint.jiraSprintId, { state: "active" });
  logs.push("Sprint activated in Jira");

  await prisma.sprint.update({
    where: { id: sprintId },
    data: { state: "active", startDate: new Date() },
  });

  await prisma.project.update({
    where: { id: sprint.projectId },
    data: { activeSprintId: sprint.jiraSprintId },
  });
  logs.push("Project updated with active sprint");

  await prisma.auditLog.create({
    data: {
      projectId: sprint.projectId,
      action: "sprint.started",
      actor: "user",
      details: JSON.stringify({ sprintName: sprint.name, jiraSprintId: sprint.jiraSprintId }),
    },
  });

  await startScheduler();
  logs.push("Lyra scheduler started — dispatcher, QA runner, and monitors active");

  return { logs };
}

// ── Complete Sprint ──────────────────────────────────────────────────

export async function completeSprint(sprintId: string): Promise<{ logs: string[]; completedPoints: number }> {
  const logs: string[] = [];

  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  if (!sprint) throw new Error("Sprint not found");

  // Get sprint issues from Jira to calculate completed points
  const sprintIssues = await jira.getSprintIssues(sprint.jiraSprintId);
  const spField = await jira.getStoryPointsFieldId();

  let completedPoints = 0;
  const issues = sprintIssues.issues || [];
  for (const issue of issues) {
    const status = issue.fields?.status?.statusCategory?.key;
    if (status === "done") {
      const points = spField ? (issue.fields[spField] as number) || 0 : 0;
      completedPoints += points;
    }
  }

  logs.push(`Completed points: ${completedPoints} / ${sprint.plannedPoints} planned`);

  // Close sprint in Jira
  await jira.updateSprint(sprint.jiraSprintId, { state: "closed" });
  logs.push("Sprint closed in Jira");

  // Update local records
  await prisma.sprint.update({
    where: { id: sprintId },
    data: { state: "closed", completedPoints, endDate: new Date() },
  });

  await prisma.project.update({
    where: { id: sprint.projectId },
    data: { activeSprintId: null },
  });
  logs.push("Project active sprint cleared");

  await prisma.auditLog.create({
    data: {
      projectId: sprint.projectId,
      action: "sprint.completed",
      actor: "user",
      details: JSON.stringify({
        sprintName: sprint.name,
        plannedPoints: sprint.plannedPoints,
        completedPoints,
      }),
    },
  });

  // Auto-generate release notes (non-fatal)
  try {
    const demoData = await gatherDemoData(sprint.projectId, sprintId);
    await generateReleaseNotes({
      projectId: sprint.projectId,
      sprintId,
      sprintName: sprint.name,
      sprintGoal: sprint.goal,
      tickets: demoData.tickets,
      totals: demoData.totals,
      projectPath: demoData.project.path,
      projectName: demoData.project.name,
      runCmd: demoData.project.runCmd,
    });
    logs.push("Release notes generated");
  } catch (e) {
    logs.push(`Release notes generation failed: ${(e as Error).message}`);
  }

  return { logs, completedPoints };
}

// ── Pre-Sprint Team Gap Analysis ─────────────────────────────────────

export type TeamGap = {
  role: string;
  label: string;
  storiesRequiring: number;
  agentsAvailable: number;
  severity: "critical" | "warning"; // critical = 0 agents, warning = understaffed
};

export async function analyzeTeamGaps(
  projectId: string,
  selectedKeys: string[]
): Promise<TeamGap[]> {
  if (selectedKeys.length === 0) return [];

  // Fetch selected issues and extract roles
  const jql = `key in (${selectedKeys.join(",")})`;
  const result = await jira.searchIssues(jql);
  const issues = result.issues || [];

  const roleNames = await getRoleNames();
  const rolePattern = new RegExp(`\\*\\*Assigned Role\\*\\*:\\s*(${roleNames.join("|")})`, "i");

  // Count stories per role
  const storiesPerRole = new Map<string, number>();
  for (const issue of issues) {
    const desc = issue.fields.description?.content
      ?.map((block: { content?: Array<{ text?: string }> }) =>
        block.content?.map((c: { text?: string }) => c.text).join("") || ""
      )
      .join("\n") || "";

    const match = desc.match(rolePattern);
    const role = match?.[1]?.toLowerCase() || "dev";
    storiesPerRole.set(role, (storiesPerRole.get(role) || 0) + 1);
  }

  // Count agents per role for this project
  const agents = await prisma.agent.findMany({
    where: { projectId },
    select: { role: true },
  });
  const agentsPerRole = new Map<string, number>();
  for (const agent of agents) {
    agentsPerRole.set(agent.role, (agentsPerRole.get(agent.role) || 0) + 1);
  }

  // Get role labels
  const roles = await getAllRoles();
  const roleLabelMap = new Map(roles.map((r) => [r.role, r.label]));

  // Build gaps
  const gaps: TeamGap[] = [];
  for (const [role, storyCount] of storiesPerRole) {
    const agentCount = agentsPerRole.get(role) || 0;

    if (agentCount === 0) {
      gaps.push({
        role,
        label: roleLabelMap.get(role) || role,
        storiesRequiring: storyCount,
        agentsAvailable: 0,
        severity: "critical",
      });
    } else if (storyCount > agentCount * 3) {
      gaps.push({
        role,
        label: roleLabelMap.get(role) || role,
        storiesRequiring: storyCount,
        agentsAvailable: agentCount,
        severity: "warning",
      });
    }
  }

  return gaps;
}

// ── Update Sprint Completed Points (called by dispatcher) ───────────

export async function updateSprintProgress(projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project?.activeSprintId) return;

  const sprint = await prisma.sprint.findFirst({
    where: { jiraSprintId: project.activeSprintId },
  });
  if (!sprint) return;

  // Count story points from sprint issues in Jira
  const sprintIssues = await jira.getSprintIssues(sprint.jiraSprintId);
  const spField = await jira.getStoryPointsFieldId();

  let completedPoints = 0;
  let plannedPoints = 0;
  for (const issue of sprintIssues.issues || []) {
    const pts = spField ? (issue.fields[spField] as number) || 0 : 0;
    plannedPoints += pts;
    const status = issue.fields?.status?.statusCategory?.key;
    if (status === "done") {
      completedPoints += pts;
    }
  }

  // If sprint has no story points, fall back to counting all project tickets
  // worked on during this sprint period (1 ticket = 1 point)
  if (plannedPoints === 0) {
    const allTodo = await jira.searchIssues(
      `project = ${project.jiraKey} AND status != "Done" ORDER BY rank ASC`
    );
    const allDone = await jira.searchIssues(
      `project = ${project.jiraKey} AND status = "Done" ORDER BY rank ASC`
    );
    const doneCount = allDone.issues?.length || 0;
    const totalCount = doneCount + (allTodo.issues?.length || 0);
    plannedPoints = totalCount;
    completedPoints = doneCount;
  }

  await prisma.sprint.update({
    where: { id: sprint.id },
    data: { completedPoints, plannedPoints },
  });
}
