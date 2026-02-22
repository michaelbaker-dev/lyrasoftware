/**
 * Role Configuration — data-driven role management.
 * Roles are stored in the RoleConfig table instead of being hardcoded.
 * Provides seeding, querying, and caching for role configurations.
 */

import { prisma } from "./db";

// ── Types ────────────────────────────────────────────────────────────

export type RoleConfigData = {
  id: string;
  role: string;
  label: string;
  phase: number;
  prompt: string | null;
  color: string;
  isBuiltIn: boolean;
};

// ── Quality-gate-aware workflow preamble (prepended to all role prompts) ──

const AGENT_WORKFLOW = `## How Your Work Is Validated
After you finish, an automated quality gate checks your work:
1. Your branch has commits (git log baseBranch..HEAD)
2. TypeScript compiles (tsc --noEmit) — if tsconfig.json exists
3. Tests pass (npm test) — if a test script exists
4. Acceptance criteria are met (AI reviews your git diff and agent output)

## Critical Requirements
- ALL files you create or modify MUST be git add'd and committed before you finish
- Your git diff IS the primary evidence — if a file isn't in the diff, the quality gate cannot see it
- Run verification commands (build, test, type-check) and include the output in your response
- If previous work exists from a prior session (files already created, commits already present), continue from that point — do not start over
- Before finishing, run: git status, git diff --stat, and verify all your work is committed
`;

// ── Built-in role definitions ────────────────────────────────────────

const BUILT_IN_ROLES: Omit<RoleConfigData, "id">[] = [
  {
    role: "architect",
    label: "Architect",
    phase: 10,
    prompt: AGENT_WORKFLOW + `You are an Architect agent. Design and scaffold the implementation.
Create file structure, interfaces, type definitions, and core abstractions.
Focus on setting up the foundation that dev agents will build upon.
For initialization/scaffolding stories, you ARE expected to create package.json, tsconfig.json, config files, and directory structures.
After creating files, run any available build/compile commands to verify your setup works.
Follow the project CLAUDE.md for conventions.`,
    color: "amber",
    isBuiltIn: true,
  },
  {
    role: "dev",
    label: "Developer",
    phase: 20,
    prompt: AGENT_WORKFLOW + `You are a Development agent. Implement the feature fully.
Follow the project CLAUDE.md for conventions.
Write clean, tested code. After implementation, run the test suite and include the output.
If tests fail, fix them before finishing. Ensure all tests pass before completing.`,
    color: "blue",
    isBuiltIn: true,
  },
  {
    role: "qa",
    label: "QA",
    phase: 30,
    prompt: AGENT_WORKFLOW + `You are a QA agent. Create comprehensive tests for the feature.
Write unit tests, integration tests, and edge case tests.
Use the project's testing framework as specified in CLAUDE.md.
Run all tests and include the full output in your response.
Ensure all tests pass and provide good coverage.`,
    color: "yellow",
    isBuiltIn: true,
  },
  {
    role: "security",
    label: "Security",
    phase: 40,
    prompt: AGENT_WORKFLOW + `You are a Security agent. Run security analysis on the codebase.
Identify vulnerabilities, review authentication/authorization flows,
check for OWASP top 10 issues, and suggest security improvements.
Follow the project CLAUDE.md for conventions.`,
    color: "red",
    isBuiltIn: true,
  },
  {
    role: "docs",
    label: "Documentation",
    phase: 50,
    prompt: AGENT_WORKFLOW + `You are a Documentation agent. Generate and update project documentation.
Write clear README files, API docs, architecture guides, and inline documentation.
Document what has been built and tested. Follow the project CLAUDE.md for conventions.`,
    color: "indigo",
    isBuiltIn: true,
  },
];

// ── Cache ────────────────────────────────────────────────────────────

let roleCache: RoleConfigData[] | null = null;
let roleCacheExpiry = 0;
const CACHE_TTL = 60_000; // 1 minute

export function invalidateRoleCache(): void {
  roleCache = null;
  roleCacheExpiry = 0;
}

// ── Public API ───────────────────────────────────────────────────────

/** Seed built-in roles on first run (upsert — safe to call repeatedly). */
export async function seedRoles(): Promise<void> {
  for (const role of BUILT_IN_ROLES) {
    await prisma.roleConfig.upsert({
      where: { role: role.role },
      update: { prompt: role.prompt }, // Apply updated prompts on re-seed
      create: {
        role: role.role,
        label: role.label,
        phase: role.phase,
        prompt: role.prompt,
        color: role.color,
        isBuiltIn: role.isBuiltIn,
      },
    });
  }
}

/** Get all roles, ordered by phase. Cached for 1 minute. */
export async function getAllRoles(): Promise<RoleConfigData[]> {
  if (roleCache && Date.now() < roleCacheExpiry) {
    return roleCache;
  }

  const roles = await prisma.roleConfig.findMany({
    orderBy: { phase: "asc" },
  });

  // If no roles exist yet, seed and retry
  if (roles.length === 0) {
    await seedRoles();
    const seeded = await prisma.roleConfig.findMany({
      orderBy: { phase: "asc" },
    });
    roleCache = seeded;
    roleCacheExpiry = Date.now() + CACHE_TTL;
    return seeded;
  }

  roleCache = roles;
  roleCacheExpiry = Date.now() + CACHE_TTL;
  return roles;
}

/** Get a single role's prompt. Returns dev prompt as fallback. */
export async function getRolePrompt(role: string): Promise<string> {
  const roles = await getAllRoles();
  const found = roles.find((r) => r.role === role);
  if (found?.prompt) return found.prompt;
  const dev = roles.find((r) => r.role === "dev");
  return dev?.prompt || "You are a Development agent. Implement the feature.";
}

/** Get the phase number for a role. Returns 50 (default) if not found. */
export async function getRolePhase(role: string): Promise<number> {
  const roles = await getAllRoles();
  return roles.find((r) => r.role === role)?.phase ?? 50;
}

/** Get all role names as a list (for building dynamic regex, prompts, etc.) */
export async function getRoleNames(): Promise<string[]> {
  const roles = await getAllRoles();
  return roles.map((r) => r.role);
}

/** Build a role description string for AI prompts. */
export async function buildRoleListForPrompt(): Promise<string> {
  const roles = await getAllRoles();
  return roles.map((r) => `"${r.role}" (${r.label}, phase ${r.phase})`).join(", ");
}
