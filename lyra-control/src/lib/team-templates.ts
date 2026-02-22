/**
 * Team Templates — built-in team configurations for project onboarding.
 * Provides seedTemplates, getTemplates, applyTemplate, and getResolvedModel.
 */

import { prisma } from "./db";

// ── Types ────────────────────────────────────────────────────────────

export interface TemplateAgent {
  role: string; // Data-driven: validated against RoleConfig table
  personality: string;
  model?: string; // null/undefined = inherit from team
}

export interface TemplateTeam {
  name: string;
  specialization: string;
  model: string;
  systemPrompt: string;
  routingLabels: string[];
  routingPriority: number;
  isDefault: boolean;
  maxAgents: number;
  agents: TemplateAgent[];
}

export interface TemplateConfig {
  teams: TemplateTeam[];
}

// ── Global Model Tier Resolution ─────────────────────────────────────

export interface ModelTier {
  model: string;       // e.g. "claude-code/sonnet"
  tier: number;        // 1, 2, or 3
  reason: string;      // why this tier was selected
}

export interface TierConfig {
  tier1Model: string;  // Primary — attempts 0-2
  tier2Model: string;  // Escalation — attempts 3+
  tier3Model: string;  // Fallback — budget exhausted
}

export const DEFAULT_TIER_CONFIG: TierConfig = {
  tier1Model: "claude-code/sonnet",
  tier2Model: "claude-code/opus",
  tier3Model: "openrouter/auto",
};

export function resolveModelTier(
  attemptCount: number,
  budgetExhausted: boolean = false,
  config: TierConfig = DEFAULT_TIER_CONFIG
): ModelTier {
  if (budgetExhausted) {
    return { model: config.tier3Model, tier: 3, reason: "Claude Max budget exhausted — using fallback" };
  }

  if (attemptCount >= 3) {
    return { model: config.tier2Model, tier: 2, reason: `Escalating to ${config.tier2Model} after ${attemptCount} failed attempts` };
  }

  return { model: config.tier1Model, tier: 1, reason: "Primary model — first attempts" };
}

/** Load tier config from the Settings table, falling back to defaults. */
export async function loadTierConfig(): Promise<TierConfig> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["model_tier1", "model_tier2", "model_tier3"] } },
  });
  const map = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  return {
    tier1Model: map.model_tier1 || DEFAULT_TIER_CONFIG.tier1Model,
    tier2Model: map.model_tier2 || DEFAULT_TIER_CONFIG.tier2Model,
    tier3Model: map.model_tier3 || DEFAULT_TIER_CONFIG.tier3Model,
  };
}

// ── Model resolution ─────────────────────────────────────────────────

export function getResolvedModel(
  agent: { model?: string | null },
  team: { model: string }
): string {
  return agent.model ?? team.model ?? "claude-code/sonnet";
}

/**
 * Resolved model result — includes optional env overrides for non-standard CLI targets.
 */
export interface ResolvedModel {
  model: string;       // model arg for --model flag
  isNative: boolean;   // true = use Claude CLI, false = use OpenRouter agent
  envOverrides?: Record<string, string>;  // extra env vars for Claude CLI
}

/**
 * Resolve any model ID to a valid `claude --model` CLI argument.
 * Claude Code agents can only use Claude models — non-Claude models
 * fall back to "sonnet" with isNative: false for logging.
 * Local models (local: prefix) run through Claude Code CLI with ANTHROPIC_BASE_URL.
 */
export function resolveClaudeModel(modelId: string): ResolvedModel {
  const id = modelId.toLowerCase();

  // Version-specific Claude Code models
  if (id === "claude-code/opus-4.6") {
    return { model: "claude-opus-4-6", isNative: true };
  }
  if (id === "claude-code/sonnet-4.6") {
    return { model: "claude-sonnet-4-6", isNative: true };
  }
  if (id === "claude-code/haiku-4.5") {
    return { model: "claude-haiku-4-5", isNative: true };
  }

  // Generic aliases (latest)
  if (id === "claude-code/opus" || id.includes("claude-opus")) {
    return { model: "opus", isNative: true };
  }
  if (id === "claude-code/sonnet" || id.includes("claude-sonnet")) {
    return { model: "sonnet", isNative: true };
  }
  if (id === "claude-code/haiku" || id.includes("claude-haiku")) {
    return { model: "haiku", isNative: true };
  }

  // LM Studio local models — run through Claude Code CLI with ANTHROPIC_BASE_URL
  if (id.startsWith("local:")) {
    const lmModelId = id.slice(6); // strip "local:" prefix
    return {
      model: lmModelId,
      isNative: true,  // runs through Claude CLI, not OpenRouter agent
      envOverrides: {
        ANTHROPIC_BASE_URL: "", // filled at dispatch time from lm_studio_url setting
        ANTHROPIC_AUTH_TOKEN: "lmstudio",
      },
    };
  }

  // Non-Claude model — fallback to sonnet
  return { model: "sonnet", isNative: false };
}

// ── Built-in templates ───────────────────────────────────────────────

export const FULL_STACK_TEMPLATE: TemplateConfig = {
  teams: [
    {
      name: "Architecture",
      specialization: "architecture",
      model: "claude-code/opus",
      routingLabels: ["architecture", "design", "prd", "ard"],
      routingPriority: 10,
      isDefault: false,
      maxAgents: 2,
      systemPrompt: `You are an Architecture team agent. Your focus is system design, technical decision-making, and scaffolding.
- Design clean, maintainable architectures with clear boundaries
- Create interfaces, type definitions, and core abstractions before implementation
- Prioritize simplicity — avoid over-engineering
- Document key decisions in code comments and ADRs
- Consider scalability, security, and developer experience in all designs
- Follow the project CLAUDE.md for conventions`,
      agents: [
        {
          role: "architect",
          personality: "Systems thinker. Designs for simplicity and extensibility. Favors composition over inheritance.",
        },
      ],
    },
    {
      name: "Backend",
      specialization: "backend",
      model: "claude-code/sonnet",
      routingLabels: ["backend", "api", "database", "auth", "server"],
      routingPriority: 20,
      isDefault: true,
      maxAgents: 4,
      systemPrompt: `You are a Backend team agent. Your focus is server-side implementation, APIs, and data layer.
- Write clean, well-tested server code with proper error handling
- Design RESTful APIs with consistent patterns
- Implement proper input validation and sanitization
- Handle database migrations and queries efficiently
- Follow security best practices (auth, CORS, rate limiting)
- Follow the project CLAUDE.md for conventions`,
      agents: [
        {
          role: "dev",
          personality: "Thorough implementer. Writes clean code with comprehensive error handling. Never cuts corners on validation.",
        },
        {
          role: "dev",
          personality: "Pragmatic builder. Focuses on getting things working correctly and efficiently. Strong at API design.",
        },
      ],
    },
    {
      name: "Frontend",
      specialization: "frontend",
      model: "claude-code/sonnet",
      routingLabels: ["frontend", "ui", "ux", "css", "component"],
      routingPriority: 20,
      isDefault: false,
      maxAgents: 4,
      systemPrompt: `You are a Frontend team agent. Your focus is UI implementation, user experience, and client-side logic.
- Build accessible, responsive UI components
- Follow component composition patterns — keep components focused and reusable
- Handle loading states, error states, and edge cases in the UI
- Write semantic HTML with proper ARIA attributes
- Optimize for performance (lazy loading, memoization where needed)
- Follow the project CLAUDE.md for conventions`,
      agents: [
        {
          role: "dev",
          personality: "UI craftsperson. Builds polished, accessible interfaces. Obsessive about user experience details.",
        },
        {
          role: "dev",
          personality: "Component architect. Creates clean, reusable component hierarchies. Strong at state management.",
        },
      ],
    },
    {
      name: "QA",
      specialization: "qa",
      model: "claude-code/sonnet",
      routingLabels: ["qa", "test", "testing"],
      routingPriority: 30,
      isDefault: false,
      maxAgents: 3,
      systemPrompt: `You are a QA team agent. Your focus is testing, quality assurance, and verification.
- Write comprehensive tests: unit, integration, and edge cases
- Test both happy paths and failure modes
- Verify acceptance criteria are met with specific test cases
- Focus on regression prevention
- Use the project's testing framework as specified in CLAUDE.md
- Report findings clearly with reproduction steps`,
      agents: [
        {
          role: "qa",
          personality: "Skeptical tester. Looks for edge cases others miss. Writes failing tests first.",
        },
        {
          role: "qa",
          personality: "Systematic verifier. Methodically validates every acceptance criterion. Strong at integration testing.",
        },
      ],
    },
    {
      name: "Triage",
      specialization: "triage",
      model: "claude-code/haiku",
      routingLabels: ["chore", "deps", "lint", "docs", "config"],
      routingPriority: 40,
      isDefault: false,
      maxAgents: 2,
      systemPrompt: `You are a Triage team agent. Your focus is small fixes, maintenance tasks, and configuration.
- Handle dependency updates, linting fixes, and config changes
- Write clear documentation and comments
- Keep changes minimal and focused
- Follow the project CLAUDE.md for conventions`,
      agents: [
        {
          role: "dev",
          personality: "Efficient fixer. Handles chores and maintenance quickly without introducing risk.",
        },
      ],
    },
  ],
};

export const BACKEND_ONLY_TEMPLATE: TemplateConfig = {
  teams: [
    {
      name: "Architecture",
      specialization: "architecture",
      model: "claude-code/opus",
      routingLabels: ["architecture", "design", "prd", "ard"],
      routingPriority: 10,
      isDefault: false,
      maxAgents: 2,
      systemPrompt: FULL_STACK_TEMPLATE.teams[0].systemPrompt,
      agents: [
        {
          role: "architect",
          personality: "Systems thinker. Designs for simplicity and extensibility.",
        },
      ],
    },
    {
      name: "Backend",
      specialization: "backend",
      model: "claude-code/sonnet",
      routingLabels: ["backend", "api", "database", "auth", "server"],
      routingPriority: 20,
      isDefault: true,
      maxAgents: 4,
      systemPrompt: FULL_STACK_TEMPLATE.teams[1].systemPrompt,
      agents: [
        {
          role: "dev",
          personality: "Thorough implementer. Writes clean code with comprehensive error handling.",
        },
        {
          role: "dev",
          personality: "Pragmatic builder. Focuses on getting things working correctly and efficiently.",
        },
      ],
    },
    {
      name: "QA",
      specialization: "qa",
      model: "claude-code/sonnet",
      routingLabels: ["qa", "test", "testing"],
      routingPriority: 30,
      isDefault: false,
      maxAgents: 3,
      systemPrompt: FULL_STACK_TEMPLATE.teams[3].systemPrompt,
      agents: [
        {
          role: "qa",
          personality: "Skeptical tester. Looks for edge cases others miss. Writes failing tests first.",
        },
      ],
    },
  ],
};

export const MINIMAL_TEMPLATE: TemplateConfig = {
  teams: [
    {
      name: "Development",
      specialization: "general",
      model: "claude-code/sonnet",
      routingLabels: [],
      routingPriority: 50,
      isDefault: true,
      maxAgents: 4,
      systemPrompt: `You are a Development team agent. Handle all implementation tasks — features, fixes, and improvements.
- Write clean, tested code with proper error handling
- Follow the project CLAUDE.md for conventions
- Keep changes focused and well-documented`,
      agents: [
        {
          role: "dev",
          personality: "Thorough implementer. Writes clean code with comprehensive error handling.",
        },
        {
          role: "dev",
          personality: "Pragmatic builder. Focuses on getting things working correctly and efficiently.",
        },
      ],
    },
    {
      name: "QA",
      specialization: "qa",
      model: "claude-code/sonnet",
      routingLabels: ["qa", "test", "testing"],
      routingPriority: 30,
      isDefault: false,
      maxAgents: 3,
      systemPrompt: `You are a QA team agent. Write comprehensive tests and verify acceptance criteria.
- Test both happy paths and failure modes
- Use the project's testing framework as specified in CLAUDE.md
- Report findings clearly with reproduction steps`,
      agents: [
        {
          role: "qa",
          personality: "Skeptical tester. Looks for edge cases others miss. Writes failing tests first.",
        },
      ],
    },
  ],
};

const BUILT_IN_TEMPLATES: { name: string; description: string; config: TemplateConfig }[] = [
  {
    name: "Full Stack",
    description: "5 teams (Architecture, Backend, Frontend, QA, Triage) with 8 agents. Best for full-stack web applications.",
    config: FULL_STACK_TEMPLATE,
  },
  {
    name: "Backend Only",
    description: "3 teams (Architecture, Backend, QA) with 4 agents. Best for APIs, services, and backend-focused projects.",
    config: BACKEND_ONLY_TEMPLATE,
  },
  {
    name: "Minimal",
    description: "2 teams (Development, QA) with 3 agents. Best for small projects or getting started quickly.",
    config: MINIMAL_TEMPLATE,
  },
];

// ── Public API ───────────────────────────────────────────────────────

export async function seedTemplates(): Promise<void> {
  for (const template of BUILT_IN_TEMPLATES) {
    await prisma.teamTemplate.upsert({
      where: { name: template.name },
      update: {
        description: template.description,
        config: JSON.stringify(template.config),
        isBuiltIn: true,
      },
      create: {
        name: template.name,
        description: template.description,
        config: JSON.stringify(template.config),
        isBuiltIn: true,
      },
    });
  }
}

export async function getTemplates() {
  return prisma.teamTemplate.findMany({
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Apply a TemplateConfig directly to a project — creates teams + agents in DB.
 * This is the core logic extracted so it can be used both by applyTemplate()
 * (template name lookup) and by the onboarding team step (custom config).
 */
export async function applyConfig(
  projectId: string,
  config: TemplateConfig
): Promise<{ logs: string[] }> {
  const logs: string[] = [];

  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) {
    throw new Error("Project not found");
  }

  const prefix = project.jiraKey.toLowerCase();

  // Delete existing agents and teams for this project
  await prisma.agent.deleteMany({ where: { projectId } });
  logs.push("Cleared existing agents");

  await prisma.team.deleteMany({ where: { projectId } });
  logs.push("Cleared existing teams");

  // Create teams and agents from config
  for (const teamDef of config.teams) {
    const team = await prisma.team.create({
      data: {
        projectId,
        name: teamDef.name,
        specialization: teamDef.specialization,
        model: teamDef.model,
        systemPrompt: teamDef.systemPrompt,
        routingLabels: JSON.stringify(teamDef.routingLabels),
        routingPriority: teamDef.routingPriority,
        isDefault: teamDef.isDefault,
        maxAgents: teamDef.maxAgents,
        enabled: true,
      },
    });

    logs.push(`Created team: ${teamDef.name} (${teamDef.specialization})`);

    // Track agent counts per role for naming
    const roleCounts: Record<string, number> = {};

    for (const agentDef of teamDef.agents) {
      // Count existing agents of this role across the project for unique naming
      const existingCount = await prisma.agent.count({
        where: { projectId, role: agentDef.role },
      });
      const roleCount = roleCounts[agentDef.role] || 0;
      roleCounts[agentDef.role] = roleCount + 1;
      const agentNum = existingCount + 1;

      const agent = await prisma.agent.create({
        data: {
          name: `${prefix}-${agentDef.role}-${agentNum}`,
          role: agentDef.role,
          model: agentDef.model || null,
          personality: agentDef.personality,
          projectId,
          teamId: team.id,
        },
      });

      logs.push(`  Created agent: ${agent.name} (${agentDef.role}) → ${teamDef.name}`);
    }
  }

  return { logs };
}

export async function applyTemplate(
  projectId: string,
  templateName: string
): Promise<{ logs: string[] }> {
  const template = await prisma.teamTemplate.findUnique({
    where: { name: templateName },
  });

  if (!template) {
    throw new Error(`Template "${templateName}" not found`);
  }

  const config: TemplateConfig = JSON.parse(template.config);
  const result = await applyConfig(projectId, config);
  result.logs.push(`Applied template "${templateName}" successfully`);
  return result;
}
