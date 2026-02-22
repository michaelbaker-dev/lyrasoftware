/**
 * Breakdown Analyzer — deterministic analysis of WorkBreakdown data
 * to recommend optimal team configuration.
 *
 * No AI calls — pure logic based on story counts, types, and roles.
 */

import type { WorkBreakdown } from "./work-breakdown";
import {
  type TemplateConfig,
  FULL_STACK_TEMPLATE,
  BACKEND_ONLY_TEMPLATE,
  MINIMAL_TEMPLATE,
} from "./team-templates";

// ── Types ────────────────────────────────────────────────────────────

export type RoleCount = { stories: number; points: number };
export type StoryTypeCount = { stories: number; points: number };

export type BreakdownAnalysis = {
  roleCounts: Record<string, RoleCount>;
  storyTypeCounts: Record<string, StoryTypeCount>;
  totalStories: number;
  totalPoints: number;
  needsFrontend: boolean;
  needsBackend: boolean;
  needsArchitecture: boolean;
  needsSecurity: boolean;
  needsDocs: boolean;
  recommendedTemplateName: string;
  recommendedConfig: TemplateConfig;
};

// ── Helpers ──────────────────────────────────────────────────────────

const FRONTEND_STORY_TYPES = new Set(["ui_component"]);
const BACKEND_STORY_TYPES = new Set(["api_endpoint", "database_schema", "auth"]);
const ARCHITECTURE_STORY_TYPES = new Set(["architecture"]);
const SECURITY_STORY_TYPES = new Set(["security"]);
const DOCS_STORY_TYPES = new Set(["documentation"]);

function scaleAgentCount(points: number): number {
  if (points <= 15) return 1;
  if (points <= 30) return 2;
  if (points <= 50) return 3;
  return 4;
}

/** Deep-clone a TemplateConfig so mutations don't affect the originals. */
function cloneConfig(config: TemplateConfig): TemplateConfig {
  return JSON.parse(JSON.stringify(config));
}

// ── Main ─────────────────────────────────────────────────────────────

export function analyzeBreakdown(breakdown: WorkBreakdown): BreakdownAnalysis {
  const roleCounts: Record<string, RoleCount> = {};
  const storyTypeCounts: Record<string, StoryTypeCount> = {};
  let totalStories = 0;
  let totalPoints = 0;

  // Walk all stories
  for (const feature of breakdown.features) {
    for (const epic of feature.epics) {
      for (const story of epic.stories) {
        totalStories++;
        totalPoints += story.storyPoints;

        // Role counts
        const role = story.assigneeRole || "dev";
        if (!roleCounts[role]) roleCounts[role] = { stories: 0, points: 0 };
        roleCounts[role].stories++;
        roleCounts[role].points += story.storyPoints;

        // Story type counts
        const st = story.storyType || "general";
        if (!storyTypeCounts[st]) storyTypeCounts[st] = { stories: 0, points: 0 };
        storyTypeCounts[st].stories++;
        storyTypeCounts[st].points += story.storyPoints;
      }
    }
  }

  // Detect needs from story types present
  const storyTypes = new Set(Object.keys(storyTypeCounts));
  const roles = new Set(Object.keys(roleCounts));

  const needsFrontend = [...storyTypes].some((t) => FRONTEND_STORY_TYPES.has(t));
  const needsBackend = [...storyTypes].some((t) => BACKEND_STORY_TYPES.has(t));
  const needsArchitecture =
    [...storyTypes].some((t) => ARCHITECTURE_STORY_TYPES.has(t)) || roles.has("architect");
  const needsSecurity =
    [...storyTypes].some((t) => SECURITY_STORY_TYPES.has(t)) || roles.has("security");
  const needsDocs =
    [...storyTypes].some((t) => DOCS_STORY_TYPES.has(t)) || roles.has("docs");

  // Select base template
  let recommendedTemplateName: string;
  let baseConfig: TemplateConfig;

  if (needsFrontend && needsBackend) {
    recommendedTemplateName = "Full Stack";
    baseConfig = cloneConfig(FULL_STACK_TEMPLATE);
  } else if (needsBackend && !needsFrontend) {
    recommendedTemplateName = "Backend Only";
    baseConfig = cloneConfig(BACKEND_ONLY_TEMPLATE);
  } else {
    recommendedTemplateName = "Minimal";
    baseConfig = cloneConfig(MINIMAL_TEMPLATE);
  }

  // Scale agent counts per team based on relevant point volume
  for (const team of baseConfig.teams) {
    const spec = team.specialization;
    let relevantPoints = 0;

    if (spec === "backend") {
      relevantPoints =
        (storyTypeCounts["api_endpoint"]?.points || 0) +
        (storyTypeCounts["database_schema"]?.points || 0) +
        (storyTypeCounts["auth"]?.points || 0);
    } else if (spec === "frontend") {
      relevantPoints = storyTypeCounts["ui_component"]?.points || 0;
    } else if (spec === "qa") {
      relevantPoints = storyTypeCounts["testing"]?.points || 0;
    } else if (spec === "architecture") {
      relevantPoints = storyTypeCounts["architecture"]?.points || 0;
    } else if (spec === "general") {
      // General team gets total dev points
      relevantPoints = roleCounts["dev"]?.points || totalPoints;
    } else {
      relevantPoints = 0;
    }

    const targetAgents = scaleAgentCount(relevantPoints);

    // Scale agents: add or remove to match target
    while (team.agents.length < targetAgents && team.agents.length < team.maxAgents) {
      // Clone last agent with slight variation
      const template = team.agents[team.agents.length - 1] || team.agents[0];
      if (template) {
        team.agents.push({ ...template });
      } else {
        break;
      }
    }
    while (team.agents.length > targetAgents && team.agents.length > 1) {
      team.agents.pop();
    }
  }

  // Drop Architecture team if no architecture stories (keep it lean)
  if (!needsArchitecture) {
    baseConfig.teams = baseConfig.teams.filter((t) => t.specialization !== "architecture");
  }

  // Add Security team if needed and not present
  if (needsSecurity && !baseConfig.teams.some((t) => t.specialization === "security")) {
    const secPoints = storyTypeCounts["security"]?.points || 0;
    baseConfig.teams.push({
      name: "Security",
      specialization: "security",
      model: "claude-code/sonnet",
      routingLabels: ["security", "audit", "hardening"],
      routingPriority: 25,
      isDefault: false,
      maxAgents: 2,
      systemPrompt: `You are a Security team agent. Your focus is security audits, hardening, and vulnerability remediation.
- Review code for OWASP Top 10 vulnerabilities
- Implement proper authentication and authorization patterns
- Audit dependency security and recommend updates
- Follow the project CLAUDE.md for conventions`,
      agents: Array.from({ length: scaleAgentCount(secPoints) }, () => ({
        role: "security",
        personality: "Security-focused engineer. Methodically audits for vulnerabilities and implements defense-in-depth.",
      })),
    });
  }

  // Add Docs team if needed and not present
  if (needsDocs && !baseConfig.teams.some((t) => t.specialization === "docs")) {
    const docsPoints = storyTypeCounts["documentation"]?.points || 0;
    baseConfig.teams.push({
      name: "Documentation",
      specialization: "docs",
      model: "claude-code/haiku",
      routingLabels: ["docs", "documentation", "readme"],
      routingPriority: 45,
      isDefault: false,
      maxAgents: 2,
      systemPrompt: `You are a Documentation team agent. Your focus is creating and maintaining project documentation.
- Write clear, concise documentation for APIs, components, and workflows
- Keep README and guides up-to-date
- Follow the project CLAUDE.md for conventions`,
      agents: Array.from({ length: scaleAgentCount(docsPoints) }, () => ({
        role: "docs",
        personality: "Clear communicator. Writes documentation that developers actually want to read.",
      })),
    });
  }

  return {
    roleCounts,
    storyTypeCounts,
    totalStories,
    totalPoints,
    needsFrontend,
    needsBackend,
    needsArchitecture,
    needsSecurity,
    needsDocs,
    recommendedTemplateName,
    recommendedConfig: baseConfig,
  };
}
