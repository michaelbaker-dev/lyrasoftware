/**
 * Team Manager — dynamic agent scaling based on Lyra's decisions.
 * Manages teams, adds/archives agents based on workload and sprint health.
 * Team-aware: scaling respects team boundaries and per-team caps.
 */

import { prisma } from "./db";
import { decide, remember } from "./lyra-brain";
import { lyraEvents } from "./lyra-events";

// ── Team operations ─────────────────────────────────────────────────

export async function createTeam(params: {
  projectId: string;
  name: string;
  type?: string;
  maxAgents?: number;
  specialization?: string;
  systemPrompt?: string;
  model?: string;
  routingLabels?: string[];
  routingPriority?: number;
  isDefault?: boolean;
}): Promise<string> {
  const team = await prisma.team.create({
    data: {
      projectId: params.projectId,
      name: params.name,
      type: params.type || "scrum",
      maxAgents: params.maxAgents || 4,
      specialization: params.specialization || "general",
      systemPrompt: params.systemPrompt || null,
      model: params.model || "claude-sonnet-4-5",
      routingLabels: params.routingLabels ? JSON.stringify(params.routingLabels) : null,
      routingPriority: params.routingPriority ?? 50,
      isDefault: params.isDefault ?? false,
    },
  });

  await prisma.auditLog.create({
    data: {
      projectId: params.projectId,
      action: "team.created",
      actor: "lyra",
      details: JSON.stringify({ teamId: team.id, name: params.name, specialization: params.specialization }),
    },
  });

  return team.id;
}

export async function assignAgentToTeam(
  agentId: string,
  teamId: string
): Promise<void> {
  await prisma.agent.update({
    where: { id: agentId },
    data: { teamId },
  });
}

// ── Dynamic scaling ─────────────────────────────────────────────────

const AGENT_PERSONALITIES: Record<string, string[]> = {
  dev: [
    "Thorough implementer. Writes clean code with comprehensive error handling.",
    "Pragmatic builder. Focuses on getting things working correctly and efficiently.",
    "Detail-oriented coder. Ensures edge cases are handled and tests are comprehensive.",
  ],
  qa: [
    "Skeptical tester. Looks for edge cases others miss. Writes failing tests first.",
    "Systematic verifier. Methodically validates every acceptance criterion.",
  ],
  architect: [
    "Systems thinker. Designs for simplicity and extensibility.",
  ],
};

export async function evaluateScaling(projectId: string): Promise<{
  action: "scale_up" | "scale_down" | "none";
  role?: string;
  teamId?: string;
  reasoning: string;
}> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      agents: true,
      teams: { include: { agents: true }, where: { enabled: true } },
    },
  });

  if (!project) return { action: "none", reasoning: "Project not found" };

  const agents = project.agents;
  const idleAgents = agents.filter((a) => a.status === "idle");
  const runningAgents = agents.filter((a) => a.status === "running");

  // Get backlog size
  const { searchIssues } = await import("./jira");
  const backlogResult = await searchIssues(
    `project = ${project.jiraKey} AND status = "To Do"`
  ).catch(() => ({ issues: [] }));
  const backlogSize = (backlogResult.issues || []).length;

  // Get sprint progress
  const sprint = await prisma.sprint.findFirst({
    where: { projectId, state: "active" },
  });

  // Build per-team breakdown for richer context
  const teamBreakdown = project.teams.map((t) => ({
    name: t.name,
    specialization: t.specialization,
    model: t.model,
    idle: t.agents.filter((a) => a.status === "idle").length,
    running: t.agents.filter((a) => a.status === "running").length,
    total: t.agents.length,
    maxAgents: t.maxAgents,
    hasCapacity: t.agents.length < t.maxAgents,
  }));

  // Ask Lyra to decide
  const decision = await decide({
    projectId,
    event: "scaling_evaluation",
    question:
      "Based on the current workload, should we scale the team up, down, or keep it the same? If scaling up, specify both role and teamName.",
    data: {
      totalAgents: agents.length,
      idleAgents: idleAgents.length,
      runningAgents: runningAgents.length,
      backlogSize,
      velocityTarget: project.velocityTarget,
      sprintProgress: sprint
        ? {
            completed: sprint.completedPoints,
            planned: sprint.plannedPoints,
          }
        : null,
      agentsByRole: {
        dev: agents.filter((a) => a.role === "dev").length,
        qa: agents.filter((a) => a.role === "qa").length,
        architect: agents.filter((a) => a.role === "architect").length,
      },
      teamBreakdown,
    },
  });

  if (
    decision.action === "scale_up" &&
    decision.details.role &&
    typeof decision.details.role === "string"
  ) {
    // Try to match a team from the decision
    let teamId: string | undefined;
    if (decision.details.teamName && typeof decision.details.teamName === "string") {
      const matched = project.teams.find(
        (t) => t.name.toLowerCase() === (decision.details.teamName as string).toLowerCase()
      );
      if (matched) teamId = matched.id;
    }

    return {
      action: "scale_up",
      role: decision.details.role,
      teamId,
      reasoning: decision.reasoning,
    };
  }

  if (decision.action === "scale_down") {
    return { action: "scale_down", reasoning: decision.reasoning };
  }

  return { action: "none", reasoning: decision.reasoning };
}

export async function scaleUp(
  projectId: string,
  role: string,
  teamId?: string
): Promise<string | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: { agents: true, teams: { include: { agents: true } } },
  });

  if (!project) return null;

  // Find target team
  let targetTeam = teamId
    ? project.teams.find((t) => t.id === teamId)
    : undefined;

  // If no team specified, find the best match by role/specialization
  if (!targetTeam) {
    const specMap: Record<string, string> = {
      dev: "backend",
      qa: "qa",
      architect: "architecture",
    };
    targetTeam = project.teams.find(
      (t) => t.specialization === specMap[role] && t.agents.length < t.maxAgents
    );
    // Fallback to default team or any team with capacity
    if (!targetTeam) {
      targetTeam = project.teams.find((t) => t.isDefault && t.agents.length < t.maxAgents)
        || project.teams.find((t) => t.agents.length < t.maxAgents);
    }
  }

  // Check team capacity
  if (targetTeam && targetTeam.agents.length >= targetTeam.maxAgents) {
    console.log(`[TeamManager] Team "${targetTeam.name}" at max capacity (${targetTeam.maxAgents})`);
    return null;
  }

  const existingCount = project.agents.filter((a) => a.role === role).length;

  const personalities = AGENT_PERSONALITIES[role] || [];
  const personality =
    personalities[existingCount % personalities.length] || null;

  const agent = await prisma.agent.create({
    data: {
      name: `${project.jiraKey.toLowerCase()}-${role}-${existingCount + 1}`,
      role,
      model: null, // inherit from team
      personality,
      projectId,
      teamId: targetTeam?.id || null,
    },
  });

  await remember(projectId, "decision", {
    type: "scale_up",
    role,
    agentName: agent.name,
    teamName: targetTeam?.name || "unassigned",
    totalAgents: project.agents.length + 1,
  });

  lyraEvents.emit("notify", {
    projectId,
    severity: "info",
    title: `Team scaled up: +1 ${role}`,
    body: `Added agent ${agent.name} to ${targetTeam?.name || "project"}.`,
  });

  return agent.id;
}

export async function scaleDown(projectId: string): Promise<string | null> {
  // Find idle agents, prefer removing from over-provisioned teams
  const teams = await prisma.team.findMany({
    where: { projectId, enabled: true },
    include: { agents: true },
  });

  // Sort teams by idle ratio descending — teams with more idle agents are candidates
  const teamsWithIdle = teams
    .map((t) => ({
      ...t,
      idleAgents: t.agents.filter((a) => a.status === "idle"),
    }))
    .filter((t) => t.idleAgents.length > 0)
    .sort((a, b) => b.idleAgents.length - a.idleAgents.length);

  for (const team of teamsWithIdle) {
    for (const agent of team.idleAgents) {
      // Don't remove if it's the last agent of its role in the project
      const sameRoleCount = await prisma.agent.count({
        where: { projectId, role: agent.role },
      });

      if (sameRoleCount > 1) {
        await prisma.agent.update({
          where: { id: agent.id },
          data: { status: "idle", projectId: null, teamId: null },
        });

        await remember(projectId, "decision", {
          type: "scale_down",
          agentName: agent.name,
          role: agent.role,
          teamName: team.name,
        });

        lyraEvents.emit("notify", {
          projectId,
          severity: "info",
          title: `Team scaled down: -1 ${agent.role}`,
          body: `Archived agent ${agent.name} from ${team.name} due to reduced workload.`,
        });

        return agent.id;
      }
    }
  }

  // Fallback: check unassigned idle agents
  const unassignedIdle = await prisma.agent.findMany({
    where: { projectId, status: "idle", teamId: null },
    orderBy: { createdAt: "desc" },
  });

  for (const agent of unassignedIdle) {
    const sameRoleCount = await prisma.agent.count({
      where: { projectId, role: agent.role },
    });

    if (sameRoleCount > 1) {
      await prisma.agent.update({
        where: { id: agent.id },
        data: { status: "idle", projectId: null },
      });

      await remember(projectId, "decision", {
        type: "scale_down",
        agentName: agent.name,
        role: agent.role,
      });

      lyraEvents.emit("notify", {
        projectId,
        severity: "info",
        title: `Team scaled down: -1 ${agent.role}`,
        body: `Archived agent ${agent.name} due to reduced workload.`,
      });

      return agent.id;
    }
  }

  return null;
}
