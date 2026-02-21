/**
 * Ceremony Engine — automated Scrum ceremonies.
 * Daily standup, sprint review, sprint retrospective.
 * All outputs stored in LyraMemory for learning.
 * Ceremonies post to Slack as threaded conversations.
 */

import { prisma } from "./db";
import { searchIssues } from "./jira";
import { chat } from "./openrouter";
import { remember, reflect } from "./lyra-brain";
import { sendNotification } from "./messaging";
import { lyraEvents } from "./lyra-events";
import {
  startSlackThread,
  replyInThread,
  sendSlackMessage,
  ensureGeneralChannel,
} from "./messaging/slack";

// ── Helpers ─────────────────────────────────────────────────────────

async function postCeremonyToSlack(
  projectId: string,
  type: string,
  headerText: string,
  sections: { title: string; content: string }[],
  label?: string
): Promise<void> {
  try {
    const { threadTs, channelId } = await startSlackThread(
      projectId,
      type,
      headerText,
      label
    );

    // Post each section as a threaded reply
    for (const section of sections) {
      await replyInThread(
        channelId,
        threadTs,
        `*${section.title}*\n${section.content}`
      );
    }
  } catch (e) {
    console.warn(`[Ceremonies] Slack thread failed (non-fatal):`, (e as Error).message);
  }
}

/** Post a cross-project summary to #lyra-general */
async function postToGeneral(text: string): Promise<void> {
  try {
    const channelId = await ensureGeneralChannel();
    await sendSlackMessage(channelId, text);
  } catch {
    // Best effort — general channel may not exist
  }
}

// ── Daily Standup ───────────────────────────────────────────────────

export async function runDailyStandup(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { status: "active" },
  });

  const projectSummaries: string[] = [];

  for (const project of projects) {
    try {
      const summary = await generateStandup(project.id, project.jiraKey, project.name);
      projectSummaries.push(`*${project.name}* (${project.jiraKey}): ${summary.slice(0, 200)}`);
    } catch (e) {
      console.error(`[Ceremonies] Standup error for ${project.jiraKey}:`, e);
    }
  }

  // Post cross-project standup summary to #lyra-general
  if (projectSummaries.length > 0) {
    const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    await postToGeneral(
      `:sunrise: *Daily Standup — ${today}*\n\n${projectSummaries.join("\n\n")}`
    );
  }
}

async function generateStandup(
  projectId: string,
  jiraKey: string,
  projectName: string
): Promise<string> {
  // Get recent sessions (last 24 hours)
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const recentSessions = await prisma.session.findMany({
    where: { projectId, startedAt: { gte: since } },
    include: { agent: true },
    orderBy: { startedAt: "desc" },
  });

  // Get ticket statuses
  const [todoResult, progressResult, reviewResult] = await Promise.all([
    searchIssues(`project = ${jiraKey} AND status = "To Do"`).catch(() => ({ issues: [] })),
    searchIssues(`project = ${jiraKey} AND status = "In Progress"`).catch(() => ({ issues: [] })),
    searchIssues(`project = ${jiraKey} AND status = "Code Review"`).catch(() => ({ issues: [] })),
  ]);

  // Get gate runs
  const recentGateRuns = await prisma.qualityGateRun.findMany({
    where: { projectId, createdAt: { gte: since } },
    orderBy: { createdAt: "desc" },
  });

  const completed = recentSessions.filter((s) => s.status === "completed");
  const failed = recentSessions.filter((s) => s.status === "failed");
  const gatesPassed = recentGateRuns.filter((g) => g.passed).length;
  const gatesFailed = recentGateRuns.filter((g) => !g.passed).length;

  // Ask Lyra to summarize
  const response = await chat(
    [
      {
        role: "system",
        content:
          "You are Lyra, an AI Scrum Master. Generate a concise daily standup summary. Use bullet points. Be specific about ticket keys.",
      },
      {
        role: "user",
        content: [
          `Project: ${projectName} (${jiraKey})`,
          `Period: Last 24 hours`,
          "",
          `## Completed (${completed.length})`,
          ...completed.map(
            (s) => `- ${s.ticketKey} by ${s.agent.name} (${s.agent.role})`
          ),
          "",
          `## Failed (${failed.length})`,
          ...failed.map((s) => `- ${s.ticketKey} by ${s.agent.name}`),
          "",
          `## Quality Gates: ${gatesPassed} passed, ${gatesFailed} failed`,
          "",
          `## Current Status`,
          `- To Do: ${(todoResult.issues || []).length} tickets`,
          `- In Progress: ${(progressResult.issues || []).length} tickets`,
          `- Code Review: ${(reviewResult.issues || []).length} tickets`,
          "",
          "Generate a standup summary with: Completed, In Progress, Blocked, and Key Metrics.",
        ].join("\n"),
      },
    ],
    "openrouter/auto",
    { projectId, category: "ceremony" }
  );

  const summary = response.choices[0]?.message?.content || "No standup data available.";

  // Store in memory
  await remember(projectId, "observation", {
    type: "daily_standup",
    completed: completed.length,
    failed: failed.length,
    gatesPassed,
    gatesFailed,
    summary,
  });

  // Send notification (routes to all configured channels including Slack)
  await sendNotification({
    projectId,
    severity: "info",
    title: `Daily Standup: ${projectName}`,
    body: summary,
  });

  // Post standup as a Slack thread with breakdowns
  const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
  await postCeremonyToSlack(
    projectId,
    "standup",
    `:sunrise: *Daily Standup — ${today}*\n${projectName} (${jiraKey})`,
    [
      {
        title: ":white_check_mark: Completed",
        content: completed.length > 0
          ? completed.map((s) => `• ${s.ticketKey} — ${s.agent.name} (${s.agent.role})`).join("\n")
          : "_None_",
      },
      {
        title: ":x: Failed / Blocked",
        content: failed.length > 0
          ? failed.map((s) => `• ${s.ticketKey} — ${s.agent.name}`).join("\n")
          : "_None_",
      },
      {
        title: ":bar_chart: Metrics",
        content: [
          `• Quality gates: ${gatesPassed} passed, ${gatesFailed} failed`,
          `• Backlog: ${(todoResult.issues || []).length} to do, ${(progressResult.issues || []).length} in progress, ${(reviewResult.issues || []).length} in review`,
        ].join("\n"),
      },
      {
        title: ":brain: Lyra's Summary",
        content: summary,
      },
    ],
    `standup-${today}`
  );

  return summary;
}

// ── Sprint Review ───────────────────────────────────────────────────

export async function runSprintReview(
  projectId: string,
  sprintId: string
): Promise<string> {
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!sprint || !project) return "Sprint or project not found.";

  const sessions = await prisma.session.findMany({
    where: {
      projectId,
      startedAt: { gte: sprint.startDate || undefined },
      completedAt: { lte: sprint.endDate || undefined },
    },
    include: { agent: true },
  });

  const gateRuns = await prisma.qualityGateRun.findMany({
    where: {
      projectId,
      createdAt: {
        gte: sprint.startDate || undefined,
        lte: sprint.endDate || undefined,
      },
    },
  });

  const completed = sessions.filter((s) => s.status === "completed");
  const totalCost = sessions.reduce((sum, s) => sum + s.cost, 0);
  const gatePassRate = gateRuns.length > 0
    ? Math.round((gateRuns.filter((g) => g.passed).length / gateRuns.length) * 100)
    : 0;

  const response = await chat(
    [
      {
        role: "system",
        content:
          "You are Lyra, an AI Scrum Master. Generate a sprint review summary with key achievements, metrics, and areas of note.",
      },
      {
        role: "user",
        content: [
          `Sprint: ${sprint.name}`,
          `Project: ${project.name} (${project.jiraKey})`,
          `Goal: ${sprint.goal || "Not specified"}`,
          `Points: ${sprint.completedPoints}/${sprint.plannedPoints}`,
          "",
          `Sessions: ${sessions.length} total, ${completed.length} completed`,
          `Quality Gates: ${gateRuns.filter((g) => g.passed).length} passed, ${gateRuns.filter((g) => !g.passed).length} failed`,
          `Total Cost: $${totalCost.toFixed(2)}`,
          "",
          "Generate a sprint review with: Achievements, Velocity, Quality Metrics, Cost Analysis.",
        ].join("\n"),
      },
    ],
    "openrouter/auto",
    { projectId, category: "ceremony" }
  );

  const review = response.choices[0]?.message?.content || "No review data.";

  await remember(projectId, "reflection", {
    type: "sprint_review",
    sprintName: sprint.name,
    completedPoints: sprint.completedPoints,
    plannedPoints: sprint.plannedPoints,
    review,
  });

  await sendNotification({
    projectId,
    severity: "info",
    title: `Sprint Review: ${sprint.name}`,
    body: review,
  });

  // Post sprint review as a threaded Slack conversation
  const velocity = sprint.plannedPoints > 0
    ? Math.round((sprint.completedPoints / sprint.plannedPoints) * 100)
    : 0;

  await postCeremonyToSlack(
    projectId,
    "review",
    `:clipboard: *Sprint Review — ${sprint.name}*\n${project.name} (${project.jiraKey})\nGoal: ${sprint.goal || "N/A"}`,
    [
      {
        title: ":dart: Velocity",
        content: `${sprint.completedPoints}/${sprint.plannedPoints} points (${velocity}%)`,
      },
      {
        title: ":shield: Quality",
        content: `Gate pass rate: ${gatePassRate}%\nSessions: ${completed.length} completed, ${sessions.length - completed.length} failed`,
      },
      {
        title: ":moneybag: Cost",
        content: `$${totalCost.toFixed(2)} total AI cost this sprint`,
      },
      {
        title: ":brain: Lyra's Review",
        content: review,
      },
    ],
    sprint.name
  );

  // Also post to #lyra-general for cross-project visibility
  await postToGeneral(
    `:clipboard: *Sprint Review: ${sprint.name}* (${project.jiraKey})\n` +
    `Velocity: ${sprint.completedPoints}/${sprint.plannedPoints} pts (${velocity}%) | Gate pass: ${gatePassRate}% | Cost: $${totalCost.toFixed(2)}`
  );

  return review;
}

// ── Sprint Retrospective ────────────────────────────────────────────

export async function runSprintRetro(
  projectId: string,
  sprintId: string
): Promise<string> {
  const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!sprint || !project) return "Sprint or project not found.";

  // Use Lyra brain's reflect function for retrospective
  const reflection = await reflect(projectId);

  // Get gate stats for the sprint
  const gateRuns = await prisma.qualityGateRun.findMany({
    where: {
      projectId,
      createdAt: {
        gte: sprint.startDate || undefined,
        lte: sprint.endDate || undefined,
      },
    },
  });

  const passRate =
    gateRuns.length > 0
      ? Math.round(
          (gateRuns.filter((g) => g.passed).length / gateRuns.length) * 100
        )
      : 0;

  const response = await chat(
    [
      {
        role: "system",
        content:
          "You are Lyra, an AI Scrum Master. Generate a sprint retrospective with actionable improvements. Format each action item on its own line starting with '- ACTION:' so they can be posted individually.",
      },
      {
        role: "user",
        content: [
          `Sprint: ${sprint.name}`,
          `Project: ${project.name} (${project.jiraKey})`,
          `Velocity: ${sprint.completedPoints}/${sprint.plannedPoints} points`,
          `Gate Pass Rate: ${passRate}%`,
          "",
          `Lyra's Reflection:`,
          reflection,
          "",
          "Generate a retrospective with: What went well, What could improve, Action items for next sprint.",
        ].join("\n"),
      },
    ],
    "openrouter/auto",
    { projectId, category: "ceremony" }
  );

  const retro = response.choices[0]?.message?.content || "No retro data.";

  await remember(projectId, "reflection", {
    type: "sprint_retrospective",
    sprintName: sprint.name,
    passRate,
    retro,
  });

  await sendNotification({
    projectId,
    severity: "info",
    title: `Sprint Retrospective: ${sprint.name}`,
    body: retro,
  });

  // Post retro as threaded Slack conversation with individual action items
  // Parse action items from the retro text
  const actionItems = retro
    .split("\n")
    .filter((line) => line.match(/^[-*]\s*(ACTION|action):/i))
    .map((line) => line.replace(/^[-*]\s*(ACTION|action):\s*/i, "").trim());

  const sections: { title: string; content: string }[] = [
    {
      title: ":brain: Lyra's Retrospective",
      content: retro,
    },
  ];

  // Post individual action items as separate thread replies for reaction/discussion
  if (actionItems.length > 0) {
    sections.push({
      title: ":pushpin: Action Items (react with :+1: to prioritize)",
      content: actionItems.map((item, i) => `${i + 1}. ${item}`).join("\n"),
    });
  }

  await postCeremonyToSlack(
    projectId,
    "retro",
    `:recycle: *Sprint Retrospective — ${sprint.name}*\n${project.name} (${project.jiraKey})\nVelocity: ${sprint.completedPoints}/${sprint.plannedPoints} pts | Gate pass: ${passRate}%`,
    sections,
    sprint.name
  );

  // Post individual action items as separate replies for reactions
  try {
    const { threadTs, channelId } = (await (async () => {
      const t = await prisma.slackThread.findFirst({
        where: { projectId, type: "retro" },
        orderBy: { createdAt: "desc" },
      });
      return t ? { threadTs: t.threadTs, channelId: t.channelId } : { threadTs: "", channelId: "" };
    })());

    if (threadTs && channelId) {
      for (const item of actionItems) {
        await replyInThread(channelId, threadTs, `:arrow_right: ${item}`);
      }
    }
  } catch {
    // Best effort
  }

  return retro;
}

// ── Stale Ticket Check ──────────────────────────────────────────────

export async function runStaleTicketCheck(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { status: "active" },
  });

  for (const project of projects) {
    try {
      // Find tickets stuck In Progress for more than 2 hours
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const stuckSessions = await prisma.session.findMany({
        where: {
          projectId: project.id,
          status: "running",
          startedAt: { lt: twoHoursAgo },
        },
        include: { agent: true },
      });

      for (const session of stuckSessions) {
        const hours = Math.round((Date.now() - session.startedAt.getTime()) / (60 * 60 * 1000));
        await sendNotification({
          projectId: project.id,
          severity: "warning",
          title: `Stale ticket: ${session.ticketKey}`,
          body: `:hourglass: Agent *${session.agent.name}* has been working on *${session.ticketKey}* for ${hours} hours. May be stuck.`,
        });
      }
    } catch (e) {
      console.error(`[Ceremonies] Stale check error for ${project.jiraKey}:`, e);
    }
  }
}

// ── Sprint Health Check ─────────────────────────────────────────────

export async function runSprintHealthCheck(): Promise<void> {
  const projects = await prisma.project.findMany({
    where: { status: "active", activeSprintId: { not: null } },
  });

  for (const project of projects) {
    try {
      const sprint = await prisma.sprint.findFirst({
        where: { projectId: project.id, state: "active" },
      });

      if (!sprint || !sprint.endDate) continue;

      const now = new Date();
      const sprintEnd = new Date(sprint.endDate);
      const totalDays = sprint.startDate
        ? (sprintEnd.getTime() - new Date(sprint.startDate).getTime()) / (24 * 60 * 60 * 1000)
        : project.sprintLength;
      const daysRemaining = Math.max(0, (sprintEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
      const daysElapsed = totalDays - daysRemaining;

      const expectedProgress = totalDays > 0 ? (daysElapsed / totalDays) * 100 : 0;
      const actualProgress =
        sprint.plannedPoints > 0
          ? (sprint.completedPoints / sprint.plannedPoints) * 100
          : 0;

      // Alert if significantly behind
      if (actualProgress < expectedProgress - 20 && daysElapsed > 2) {
        await sendNotification({
          projectId: project.id,
          severity: "warning",
          title: `Sprint behind: ${sprint.name}`,
          body: `:warning: Expected ${Math.round(expectedProgress)}% complete, actual ${Math.round(actualProgress)}%. ${Math.round(daysRemaining)} days remaining.`,
        });

        lyraEvents.emit("sprint:updated", {
          projectId: project.id,
          sprintId: sprint.id,
          completedPoints: sprint.completedPoints,
          plannedPoints: sprint.plannedPoints,
        });
      }
    } catch (e) {
      console.error(`[Ceremonies] Health check error for ${project.jiraKey}:`, e);
    }
  }
}
