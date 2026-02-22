"use server";

import { prisma } from "@/lib/db";
import { seedTemplates, applyTemplate, applyConfig, type TemplateConfig } from "@/lib/team-templates";
import { revalidatePath } from "next/cache";
import {
  analyzeRebalance,
  executeRebalance,
  type RebalancePlan,
  type RebalanceResult,
} from "@/lib/team-rebalancer";
import * as jira from "@/lib/jira";
import { getRoleNames, getAllRoles } from "@/lib/role-config";
import { setupProjectChannel, reinviteOwner } from "@/lib/messaging/slack";

// ── Team CRUD ────────────────────────────────────────────────────────

export async function updateTeam(
  teamId: string,
  data: {
    name?: string;
    specialization?: string;
    model?: string;
    systemPrompt?: string | null;
    routingLabels?: string;
    routingPriority?: number;
    isDefault?: boolean;
    maxAgents?: number;
    enabled?: boolean;
  }
) {
  const team = await prisma.team.update({
    where: { id: teamId },
    data,
  });

  // If setting isDefault, unset all others for the same project
  if (data.isDefault === true) {
    await prisma.team.updateMany({
      where: { projectId: team.projectId, id: { not: teamId } },
      data: { isDefault: false },
    });
  }

  revalidatePath(`/projects/${team.projectId}`);
  revalidatePath("/agents");
  return { success: true };
}

export async function deleteTeam(teamId: string) {
  const team = await prisma.team.findUnique({ where: { id: teamId } });
  if (!team) return { success: false, error: "Team not found" };

  // Unassign agents from team before deleting
  await prisma.agent.updateMany({
    where: { teamId },
    data: { teamId: null },
  });

  await prisma.team.delete({ where: { id: teamId } });

  await prisma.auditLog.create({
    data: {
      projectId: team.projectId,
      action: "team.deleted",
      actor: "user",
      details: JSON.stringify({ teamId, teamName: team.name }),
    },
  });

  revalidatePath(`/projects/${team.projectId}`);
  revalidatePath("/agents");
  return { success: true };
}

export async function addTeam(
  projectId: string,
  data: {
    name: string;
    specialization: string;
    model: string;
    systemPrompt?: string;
    routingLabels?: string[];
    routingPriority?: number;
    maxAgents?: number;
  }
) {
  const team = await prisma.team.create({
    data: {
      projectId,
      name: data.name,
      specialization: data.specialization,
      model: data.model,
      systemPrompt: data.systemPrompt || null,
      routingLabels: data.routingLabels ? JSON.stringify(data.routingLabels) : null,
      routingPriority: data.routingPriority ?? 50,
      maxAgents: data.maxAgents ?? 4,
      isDefault: false,
      enabled: true,
    },
  });

  await prisma.auditLog.create({
    data: {
      projectId,
      action: "team.created",
      actor: "user",
      details: JSON.stringify({ teamId: team.id, teamName: data.name }),
    },
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/agents");
  return { success: true, teamId: team.id };
}

// ── Agent CRUD ───────────────────────────────────────────────────────

export async function updateAgent(
  agentId: string,
  data: {
    personality?: string | null;
    model?: string | null;
    name?: string;
  }
) {
  const agent = await prisma.agent.update({
    where: { id: agentId },
    data,
  });

  if (agent.projectId) {
    revalidatePath(`/projects/${agent.projectId}`);
  }
  revalidatePath("/agents");
  return { success: true };
}

export async function addAgentToTeam(
  teamId: string,
  data: {
    role: string;
    personality?: string;
  }
) {
  const team = await prisma.team.findUnique({
    where: { id: teamId },
    include: { agents: true },
  });

  if (!team) return { success: false, error: "Team not found" };

  if (team.agents.length >= team.maxAgents) {
    return { success: false, error: `Team "${team.name}" already at max capacity (${team.maxAgents})` };
  }

  const project = await prisma.project.findUnique({ where: { id: team.projectId } });
  const prefix = project?.jiraKey?.toLowerCase() || "agent";
  const existingCount = await prisma.agent.count({
    where: { projectId: team.projectId, role: data.role },
  });

  const agent = await prisma.agent.create({
    data: {
      name: `${prefix}-${data.role}-${existingCount + 1}`,
      role: data.role,
      model: null, // inherit from team
      personality: data.personality || null,
      projectId: team.projectId,
      teamId,
    },
  });

  await prisma.auditLog.create({
    data: {
      projectId: team.projectId,
      action: "agent.created",
      actor: "user",
      details: JSON.stringify({ agentId: agent.id, agentName: agent.name, teamId }),
    },
  });

  revalidatePath(`/projects/${team.projectId}`);
  revalidatePath("/agents");
  return { success: true, agentId: agent.id };
}

export async function removeAgent(agentId: string) {
  const agent = await prisma.agent.findUnique({ where: { id: agentId } });
  if (!agent) return { success: false, error: "Agent not found" };

  if (agent.status === "running") {
    return { success: false, error: "Cannot remove a running agent" };
  }

  await prisma.agent.delete({ where: { id: agentId } });

  await prisma.auditLog.create({
    data: {
      projectId: agent.projectId,
      action: "agent.removed",
      actor: "user",
      details: JSON.stringify({ agentId, agentName: agent.name }),
    },
  });

  if (agent.projectId) {
    revalidatePath(`/projects/${agent.projectId}`);
  }
  revalidatePath("/agents");
  return { success: true };
}

// ── Template application ─────────────────────────────────────────────

export async function applyTemplateAction(
  projectId: string,
  templateName: string
) {
  await seedTemplates();
  const result = await applyTemplate(projectId, templateName);

  await prisma.auditLog.create({
    data: {
      projectId,
      action: "template.applied",
      actor: "user",
      details: JSON.stringify({ templateName }),
    },
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/agents");
  return { success: true, logs: result.logs };
}

export async function getAvailableTemplates() {
  await seedTemplates();
  return prisma.teamTemplate.findMany({
    orderBy: { createdAt: "asc" },
    select: { name: true, description: true, isBuiltIn: true },
  });
}

export async function getAvailableRoles() {
  const { getAllRoles } = await import("@/lib/role-config");
  const roles = await getAllRoles();
  return roles.map((r) => ({ role: r.role, label: r.label, color: r.color }));
}

// ── Role-to-Team mapping for gap resolution ─────────────────────────

const ROLE_TEAM_DEFAULTS: Record<
  string,
  {
    specialization: string;
    teamName: string;
    model: string;
    routingLabels: string[];
    routingPriority: number;
    systemPrompt: string;
    personality: string;
  }
> = {
  architect: {
    specialization: "architecture",
    teamName: "Architecture",
    model: "claude-code/opus",
    routingLabels: ["architecture", "design", "prd", "ard"],
    routingPriority: 10,
    systemPrompt:
      "You are an Architecture team agent. Your focus is system design, technical decision-making, and scaffolding.\n- Design clean, maintainable architectures with clear boundaries\n- Create interfaces, type definitions, and core abstractions before implementation\n- Prioritize simplicity — avoid over-engineering\n- Document key decisions in code comments and ADRs\n- Consider scalability, security, and developer experience in all designs\n- Follow the project CLAUDE.md for conventions",
    personality:
      "Systems thinker. Designs for simplicity and extensibility. Favors composition over inheritance.",
  },
  dev: {
    specialization: "backend",
    teamName: "Backend",
    model: "claude-code/sonnet",
    routingLabels: ["backend", "api", "database", "auth", "server"],
    routingPriority: 20,
    systemPrompt:
      "You are a Backend team agent. Your focus is server-side implementation, APIs, and data layer.\n- Write clean, well-tested server code with proper error handling\n- Design RESTful APIs with consistent patterns\n- Implement proper input validation and sanitization\n- Handle database migrations and queries efficiently\n- Follow security best practices (auth, CORS, rate limiting)\n- Follow the project CLAUDE.md for conventions",
    personality:
      "Thorough implementer. Writes clean code with comprehensive error handling. Never cuts corners on validation.",
  },
  qa: {
    specialization: "qa",
    teamName: "QA",
    model: "claude-code/sonnet",
    routingLabels: ["qa", "test", "testing"],
    routingPriority: 30,
    systemPrompt:
      "You are a QA team agent. Your focus is testing, quality assurance, and verification.\n- Write comprehensive tests: unit, integration, and edge cases\n- Test both happy paths and failure modes\n- Verify acceptance criteria are met with specific test cases\n- Focus on regression prevention\n- Use the project's testing framework as specified in CLAUDE.md\n- Report findings clearly with reproduction steps",
    personality:
      "Skeptical tester. Looks for edge cases others miss. Writes failing tests first.",
  },
  security: {
    specialization: "security",
    teamName: "Security",
    model: "claude-code/sonnet",
    routingLabels: ["security", "auth", "vulnerabilities"],
    routingPriority: 35,
    systemPrompt:
      "You are a Security team agent. Your focus is security analysis, vulnerability assessment, and hardening.\n- Identify vulnerabilities and review authentication/authorization flows\n- Check for OWASP top 10 issues\n- Suggest security improvements\n- Follow the project CLAUDE.md for conventions",
    personality:
      "Security-focused analyst. Identifies vulnerabilities and suggests hardening measures.",
  },
  docs: {
    specialization: "documentation",
    teamName: "Documentation",
    model: "claude-code/sonnet",
    routingLabels: ["docs", "documentation", "readme"],
    routingPriority: 45,
    systemPrompt:
      "You are a Documentation team agent. Your focus is generating and updating project documentation.\n- Write clear README files, API docs, and architecture guides\n- Document what has been built and tested\n- Follow the project CLAUDE.md for conventions",
    personality:
      "Clear communicator. Writes documentation that developers actually want to read.",
  },
};

/** Create an agent for a specific role, assigning it to the correct team
 *  by specialization. Creates the team if it doesn't exist.
 *  Used by the sprint manager gap resolution flow. */
export async function createAgentForRole(
  projectId: string,
  role: string
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  const roleDefaults = ROLE_TEAM_DEFAULTS[role];
  let teamCreated = false;

  // Type for team query result with agents included
  type TeamWithAgents = NonNullable<
    Awaited<
      ReturnType<
        typeof prisma.team.findFirst<{
          include: { agents: true };
        }>
      >
    >
  >;

  let team: TeamWithAgents | null = null;

  if (roleDefaults) {
    // Look for an existing team matching this role's specialization
    team = await prisma.team.findFirst({
      where: { projectId, specialization: roleDefaults.specialization, enabled: true },
      include: { agents: true },
    });

    // No matching team — create one
    if (!team) {
      const created = await prisma.team.create({
        data: {
          projectId,
          name: roleDefaults.teamName,
          specialization: roleDefaults.specialization,
          model: roleDefaults.model,
          systemPrompt: roleDefaults.systemPrompt,
          routingLabels: JSON.stringify(roleDefaults.routingLabels),
          routingPriority: roleDefaults.routingPriority,
          maxAgents: 4,
          isDefault: false,
          enabled: true,
        },
        include: { agents: true },
      });
      team = created;
      teamCreated = true;
    }
  } else {
    // Unknown role — fall back to default team (existing behavior)
    team = await prisma.team.findFirst({
      where: { projectId, isDefault: true, enabled: true },
      include: { agents: true },
    });

    if (!team) {
      team = await prisma.team.findFirst({
        where: { projectId, enabled: true },
        include: { agents: true },
      });
    }
  }

  if (!team) {
    return { success: false, error: "No team found. Create a team first in Team Config." };
  }

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  const prefix = project?.jiraKey?.toLowerCase() || "agent";
  const existingCount = await prisma.agent.count({ where: { projectId, role } });

  const agent = await prisma.agent.create({
    data: {
      name: `${prefix}-${role}-${existingCount + 1}`,
      role,
      model: null, // inherit from team
      personality: roleDefaults?.personality || null,
      projectId,
      teamId: team.id,
    },
  });

  await prisma.auditLog.create({
    data: {
      projectId,
      action: "agent.created",
      actor: "user",
      details: JSON.stringify({
        agentId: agent.id,
        agentName: agent.name,
        teamId: team.id,
        teamName: team.name,
        teamCreated,
        source: "gap-analysis",
      }),
    },
  });

  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/agents");
  return { success: true, agentName: agent.name };
}

// ── Rebalance ────────────────────────────────────────────────────────

export async function analyzeRebalanceAction(
  projectId: string,
  model?: string
): Promise<{ success: boolean; plan?: RebalancePlan; error?: string }> {
  try {
    const plan = await analyzeRebalance(projectId, model);
    return { success: true, plan };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function executeRebalanceAction(
  projectId: string,
  plan: RebalancePlan,
  approvedTicketKeys: string[],
  approvedStoryIndices: number[]
): Promise<{ success: boolean; result?: RebalanceResult; error?: string }> {
  try {
    const result = await executeRebalance(
      plan,
      approvedTicketKeys,
      approvedStoryIndices
    );
    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/agents");
    return { success: true, result };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// ── Team Validation ──────────────────────────────────────────────────

export type TeamGapItem = {
  role: string;
  label: string;
  color: string;
  storiesRequiring: number;
  agentsAvailable: number;
  severity: "critical" | "warning" | "ok";
};

export type ValidationResult = {
  totalTickets: number;
  storiesPerRole: Record<string, number>;
  gaps: TeamGapItem[];
  hasSavedConfig: boolean;
  savedConfigTeams: number;
  savedConfigAgents: number;
  currentTeams: number;
  currentAgents: number;
};

export async function validateTeamAction(
  projectId: string
): Promise<{ success: boolean; result?: ValidationResult; error?: string }> {
  try {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project) return { success: false, error: "Project not found" };

    // Fetch all project tickets from Jira
    const jql = `project = ${project.jiraKey} ORDER BY rank ASC`;
    const searchResult = await jira.searchIssues(jql, 200);
    const issues = searchResult.issues || [];

    // Build role regex from DB
    const roleNames = await getRoleNames();
    const roles = await getAllRoles();
    const rolePattern = new RegExp(
      `\\*\\*Assigned Role\\*\\*:\\s*(${roleNames.join("|")})`,
      "i"
    );
    const roleLabelMap = new Map(roles.map((r) => [r.role, r.label]));
    const roleColorMap = new Map(roles.map((r) => [r.role, r.color]));

    // Count stories per role
    const storiesPerRole: Record<string, number> = {};
    for (const issue of issues) {
      // Skip done tickets
      const statusKey = issue.fields?.status?.statusCategory?.key;
      if (statusKey === "done") continue;

      const desc =
        issue.fields.description?.content
          ?.map(
            (block: { content?: Array<{ text?: string }> }) =>
              block.content?.map((c: { text?: string }) => c.text).join("") ||
              ""
          )
          .join("\n") || "";

      const match = desc.match(rolePattern);
      const role = match?.[1]?.toLowerCase() || "dev";
      storiesPerRole[role] = (storiesPerRole[role] || 0) + 1;
    }

    // Count agents per role
    const agents = await prisma.agent.findMany({
      where: { projectId },
      select: { role: true },
    });
    const agentsPerRole: Record<string, number> = {};
    for (const agent of agents) {
      agentsPerRole[agent.role] = (agentsPerRole[agent.role] || 0) + 1;
    }

    // Current team/agent counts
    const currentTeams = await prisma.team.count({ where: { projectId } });
    const currentAgents = agents.length;

    // Check saved config
    let hasSavedConfig = false;
    let savedConfigTeams = 0;
    let savedConfigAgents = 0;
    if (project.teamConfig) {
      try {
        const config: TemplateConfig = JSON.parse(project.teamConfig);
        hasSavedConfig = true;
        savedConfigTeams = config.teams.length;
        savedConfigAgents = config.teams.reduce(
          (sum, t) => sum + t.agents.length,
          0
        );
      } catch {
        // ignore parse error
      }
    }

    // Build gaps
    const gaps: TeamGapItem[] = [];
    const allRolesInScope = new Set([
      ...Object.keys(storiesPerRole),
      ...Object.keys(agentsPerRole),
    ]);

    for (const role of allRolesInScope) {
      const storyCount = storiesPerRole[role] || 0;
      const agentCount = agentsPerRole[role] || 0;

      let severity: "critical" | "warning" | "ok" = "ok";
      if (storyCount > 0 && agentCount === 0) {
        severity = "critical";
      } else if (storyCount > agentCount * 3) {
        severity = "warning";
      }

      gaps.push({
        role,
        label: roleLabelMap.get(role) || role,
        color: roleColorMap.get(role) || "gray",
        storiesRequiring: storyCount,
        agentsAvailable: agentCount,
        severity,
      });
    }

    // Sort: critical first, then warning, then ok
    const severityOrder = { critical: 0, warning: 1, ok: 2 };
    gaps.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return {
      success: true,
      result: {
        totalTickets: issues.length,
        storiesPerRole,
        gaps,
        hasSavedConfig,
        savedConfigTeams,
        savedConfigAgents,
        currentTeams,
        currentAgents,
      },
    };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** Apply the saved teamConfig from onboarding to create actual teams/agents. */
export async function applySavedTeamConfig(
  projectId: string
): Promise<{ success: boolean; logs?: string[]; error?: string }> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });
    if (!project?.teamConfig) {
      return { success: false, error: "No saved team configuration found" };
    }

    const config: TemplateConfig = JSON.parse(project.teamConfig);
    const result = await applyConfig(projectId, config);

    await prisma.auditLog.create({
      data: {
        projectId,
        action: "team.validated",
        actor: "user",
        details: JSON.stringify({
          source: "saved-config",
          teams: config.teams.length,
          agents: config.teams.reduce((s, t) => s + t.agents.length, 0),
        }),
      },
    });

    revalidatePath(`/projects/${projectId}`);
    revalidatePath("/agents");
    return { success: true, logs: result.logs };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// ── Slack Channel Retry ──────────────────────────────────────────────

export async function retrySlackSetup(projectId: string): Promise<{
  success: boolean;
  channelName?: string;
  error?: string;
}> {
  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { jiraKey: true, slackChannelId: true },
    });
    if (!project) return { success: false, error: "Project not found" };

    // Create or verify the channel
    const channelId = await setupProjectChannel(projectId);
    const channelName = `lyra-${project.jiraKey.toLowerCase()}`;

    // Re-invite the owner (auto-detects user ID if needed)
    const inviteResult = await reinviteOwner(channelId);
    if (!inviteResult.ok) {
      return {
        success: true,
        channelName,
        error: `Channel ready but invite failed: ${inviteResult.message}`,
      };
    }

    revalidatePath(`/projects/${projectId}`);
    return { success: true, channelName };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

/** Fix a specific role gap by creating the missing agent (and team if needed). */
export async function fixRoleGap(
  projectId: string,
  role: string
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  return createAgentForRole(projectId, role);
}
