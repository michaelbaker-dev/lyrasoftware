/**
 * Project Health Check — validates project environment setup.
 * Catches systemic issues that the per-ticket quality gate misses:
 * missing .env files, worktree exclusions, build failures, etc.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";

const exec = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  passed: boolean;
  severity: "error" | "warning";
  details: string;
  autoFixed: boolean;
}

export interface HealthCheckResult {
  healthy: boolean;
  checks: HealthCheck[];
  errors: HealthCheck[];
  warnings: HealthCheck[];
  autoFixCount: number;
}

export type HealthCheckMode = "post-scaffold" | "preflight" | "full";

// ── Individual Checks ────────────────────────────────────────────────

export async function checkEnvFile(
  projectPath: string,
  autoFix: boolean
): Promise<HealthCheck> {
  const envExample = join(projectPath, ".env.example");
  const envFile = join(projectPath, ".env");

  if (!existsSync(envExample)) {
    return {
      name: "Environment file",
      passed: true,
      severity: "warning",
      details: "No .env.example found — skipped",
      autoFixed: false,
    };
  }

  if (existsSync(envFile)) {
    return {
      name: "Environment file",
      passed: true,
      severity: "error",
      details: ".env exists",
      autoFixed: false,
    };
  }

  if (autoFix) {
    copyFileSync(envExample, envFile);
    return {
      name: "Environment file",
      passed: true,
      severity: "error",
      details: "Missing .env — auto-copied from .env.example",
      autoFixed: true,
    };
  }

  return {
    name: "Environment file",
    passed: false,
    severity: "error",
    details: ".env.example exists but .env is missing — copy .env.example to .env and fill in values",
    autoFixed: false,
  };
}

export async function checkTsconfigExcludes(
  projectPath: string,
  autoFix: boolean
): Promise<HealthCheck> {
  const tsconfigPath = join(projectPath, "tsconfig.json");

  if (!existsSync(tsconfigPath)) {
    return {
      name: "tsconfig.json excludes worktrees",
      passed: true,
      severity: "error",
      details: "No tsconfig.json found — skipped",
      autoFixed: false,
    };
  }

  const raw = readFileSync(tsconfigPath, "utf-8");

  // String-scan for "worktrees" in exclude array (avoid full JSON parse for
  // files with comments/trailing commas)
  if (raw.includes('"worktrees"') || raw.includes("'worktrees'")) {
    return {
      name: "tsconfig.json excludes worktrees",
      passed: true,
      severity: "error",
      details: '"worktrees" found in tsconfig.json',
      autoFixed: false,
    };
  }

  if (autoFix) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed.exclude) {
        parsed.exclude = [];
      }
      parsed.exclude.push("worktrees");
      writeFileSync(tsconfigPath, JSON.stringify(parsed, null, 2) + "\n");
      return {
        name: "tsconfig.json excludes worktrees",
        passed: true,
        severity: "error",
        details: 'Auto-added "worktrees" to tsconfig.json exclude array',
        autoFixed: true,
      };
    } catch {
      return {
        name: "tsconfig.json excludes worktrees",
        passed: false,
        severity: "error",
        details: "tsconfig.json missing worktrees exclusion and auto-fix failed (parse error)",
        autoFixed: false,
      };
    }
  }

  return {
    name: "tsconfig.json excludes worktrees",
    passed: false,
    severity: "error",
    details: 'tsconfig.json does not exclude "worktrees" — add it to the exclude array',
    autoFixed: false,
  };
}

export async function checkTestConfigExcludes(
  projectPath: string
): Promise<HealthCheck> {
  // Scan vitest.config.* and jest.config.* for worktrees exclusion
  const configFiles = [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
  ];

  const found: string[] = [];
  const missing: string[] = [];

  for (const file of configFiles) {
    const filePath = join(projectPath, file);
    if (!existsSync(filePath)) continue;

    const content = readFileSync(filePath, "utf-8");
    if (content.includes("worktrees") || content.includes("worktree")) {
      found.push(file);
    } else {
      missing.push(file);
    }
  }

  if (found.length === 0 && missing.length === 0) {
    return {
      name: "Test config excludes worktrees",
      passed: true,
      severity: "warning",
      details: "No vitest/jest config found — skipped",
      autoFixed: false,
    };
  }

  if (missing.length > 0) {
    return {
      name: "Test config excludes worktrees",
      passed: false,
      severity: "warning",
      details: `${missing.join(", ")} missing worktrees exclusion — add worktrees/ to test exclude patterns`,
      autoFixed: false,
    };
  }

  return {
    name: "Test config excludes worktrees",
    passed: true,
    severity: "warning",
    details: `worktrees exclusion found in ${found.join(", ")}`,
    autoFixed: false,
  };
}

export async function checkBuildSucceeds(
  projectPath: string
): Promise<HealthCheck> {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      name: "Build succeeds",
      passed: true,
      severity: "error",
      details: "No package.json found — skipped",
      autoFixed: false,
    };
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!pkg.scripts?.build) {
      return {
        name: "Build succeeds",
        passed: true,
        severity: "error",
        details: "No build script in package.json — skipped",
        autoFixed: false,
      };
    }
  } catch {
    return {
      name: "Build succeeds",
      passed: false,
      severity: "error",
      details: "Failed to parse package.json",
      autoFixed: false,
    };
  }

  try {
    await exec("npm", ["run", "build"], {
      cwd: projectPath,
      timeout: 300_000, // 5 minute timeout
    });
    return {
      name: "Build succeeds",
      passed: true,
      severity: "error",
      details: "npm run build passed",
      autoFixed: false,
    };
  } catch (e) {
    const err = e as Error & { stderr?: string };
    const stderr = err.stderr || err.message;
    return {
      name: "Build succeeds",
      passed: false,
      severity: "error",
      details: `npm run build failed: ${stderr.slice(0, 1000)}`,
      autoFixed: false,
    };
  }
}

export async function checkGitignore(
  projectPath: string,
  autoFix: boolean
): Promise<HealthCheck> {
  const gitignorePath = join(projectPath, ".gitignore");

  const requiredEntries = ["worktrees/", ".env", "node_modules"];

  if (!existsSync(gitignorePath)) {
    if (autoFix) {
      writeFileSync(gitignorePath, requiredEntries.join("\n") + "\n");
      return {
        name: ".gitignore completeness",
        passed: true,
        severity: "warning",
        details: "Created .gitignore with required entries",
        autoFixed: true,
      };
    }
    return {
      name: ".gitignore completeness",
      passed: false,
      severity: "warning",
      details: "No .gitignore found",
      autoFixed: false,
    };
  }

  const content = readFileSync(gitignorePath, "utf-8");
  const lines = content.split("\n").map((l) => l.trim());

  const missing = requiredEntries.filter((entry) => {
    // Check for exact match or with trailing slash variations
    return !lines.some(
      (line) =>
        line === entry ||
        line === entry.replace(/\/$/, "") ||
        line === `/${entry}` ||
        line === `/${entry.replace(/\/$/, "")}`
    );
  });

  if (missing.length === 0) {
    return {
      name: ".gitignore completeness",
      passed: true,
      severity: "warning",
      details: "All required entries present in .gitignore",
      autoFixed: false,
    };
  }

  if (autoFix) {
    const appendBlock = "\n# Auto-added by Lyra health check\n" + missing.join("\n") + "\n";
    writeFileSync(gitignorePath, content.trimEnd() + appendBlock);
    return {
      name: ".gitignore completeness",
      passed: true,
      severity: "warning",
      details: `Auto-added missing entries: ${missing.join(", ")}`,
      autoFixed: true,
    };
  }

  return {
    name: ".gitignore completeness",
    passed: false,
    severity: "warning",
    details: `.gitignore missing: ${missing.join(", ")}`,
    autoFixed: false,
  };
}

export async function checkDependencyIntegrity(
  projectPath: string
): Promise<HealthCheck> {
  const pkgPath = join(projectPath, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      name: "Dependency integrity",
      passed: true,
      severity: "warning",
      details: "No package.json found — skipped",
      autoFixed: false,
    };
  }

  const issues: string[] = [];

  if (!existsSync(join(projectPath, "package-lock.json"))) {
    issues.push("package-lock.json missing");
  }

  if (!existsSync(join(projectPath, "node_modules"))) {
    issues.push("node_modules not installed");
  }

  if (issues.length > 0) {
    return {
      name: "Dependency integrity",
      passed: false,
      severity: "warning",
      details: issues.join("; "),
      autoFixed: false,
    };
  }

  return {
    name: "Dependency integrity",
    passed: true,
    severity: "warning",
    details: "package-lock.json and node_modules present",
    autoFixed: false,
  };
}

// ── Runner ───────────────────────────────────────────────────────────

export async function runHealthCheck(params: {
  projectId?: string;
  projectPath: string;
  mode: HealthCheckMode;
  autoFix: boolean;
}): Promise<HealthCheckResult> {
  const { projectPath, mode, autoFix } = params;
  const checks: HealthCheck[] = [];

  // Always run these checks
  checks.push(await checkEnvFile(projectPath, autoFix));
  checks.push(await checkTsconfigExcludes(projectPath, autoFix));
  checks.push(await checkTestConfigExcludes(projectPath));
  checks.push(await checkGitignore(projectPath, autoFix));
  checks.push(await checkDependencyIntegrity(projectPath));

  // Build check only in full mode (slow)
  if (mode === "full") {
    checks.push(await checkBuildSucceeds(projectPath));
  }

  const errors = checks.filter((c) => !c.passed && c.severity === "error");
  const warnings = checks.filter((c) => !c.passed && c.severity === "warning");
  const autoFixCount = checks.filter((c) => c.autoFixed).length;
  const healthy = errors.length === 0;

  // Persist to audit log
  if (params.projectId) {
    try {
      await prisma.auditLog.create({
        data: {
          projectId: params.projectId,
          action: `health_check.${mode}`,
          actor: "lyra",
          details: JSON.stringify({
            healthy,
            mode,
            autoFix,
            autoFixCount,
            errorCount: errors.length,
            warningCount: warnings.length,
            checks: checks.map((c) => ({
              name: c.name,
              passed: c.passed,
              severity: c.severity,
              autoFixed: c.autoFixed,
              details: c.details.slice(0, 500),
            })),
          }),
        },
      });
    } catch (e) {
      console.warn("[HealthCheck] Failed to persist audit log:", e);
    }
  }

  // Emit notification
  lyraEvents.emit("notify", {
    projectId: params.projectId || "system",
    severity: healthy ? "info" : "warning",
    title: "Project Health Check",
    body: healthy
      ? `Health check passed (${mode}${autoFixCount > 0 ? `, ${autoFixCount} auto-fixed` : ""})`
      : `Health check found ${errors.length} error(s), ${warnings.length} warning(s)`,
  });

  return { healthy, checks, errors, warnings, autoFixCount };
}
