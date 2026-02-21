/**
 * Quality Gate — validates agent work before PR creation.
 * Runs a series of checks and uses Lyra's brain for AC validation.
 *
 * Check order:
 * 1. Branch has commits (git log)
 * 2. TypeScript compiles (tsc --noEmit)
 * 3. Tests pass (npm test, if script exists)
 * 4. Acceptance criteria met (AI validation via Lyra brain)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import { decide, validateAcceptanceCriteria } from "./lyra-brain";

const exec = promisify(execFile);

export interface GateCheck {
  name: string;
  passed: boolean;
  details: string;
}

export interface QualityGateResult {
  passed: boolean;
  alreadyDone: boolean; // true when AC met with zero code changes
  checks: GateCheck[];
  reasoning: string;
}

// ── Individual checks ───────────────────────────────────────────────

async function checkBranchHasCommits(
  worktreePath: string,
  baseBranch: string
): Promise<GateCheck> {
  try {
    const { stdout } = await exec(
      "git",
      ["log", `${baseBranch}..HEAD`, "--oneline"],
      { cwd: worktreePath }
    );
    const commits = stdout.trim().split("\n").filter(Boolean);
    if (commits.length === 0) {
      return {
        name: "Branch has commits",
        passed: false,
        details: "No commits found on branch since base",
      };
    }
    return {
      name: "Branch has commits",
      passed: true,
      details: `${commits.length} commit(s): ${commits[0]}`,
    };
  } catch (e) {
    return {
      name: "Branch has commits",
      passed: false,
      details: `Git error: ${(e as Error).message}`,
    };
  }
}

async function checkTypeScriptCompiles(
  worktreePath: string
): Promise<GateCheck> {
  // Check if tsconfig exists
  if (!existsSync(join(worktreePath, "tsconfig.json"))) {
    return {
      name: "TypeScript compiles",
      passed: true,
      details: "No tsconfig.json found — skipped",
    };
  }

  try {
    await exec("npx", ["tsc", "--noEmit"], {
      cwd: worktreePath,
      timeout: 120_000,
    });
    return {
      name: "TypeScript compiles",
      passed: true,
      details: "No type errors",
    };
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr || "";
    const errorCount = (stderr.match(/error TS/g) || []).length;
    return {
      name: "TypeScript compiles",
      passed: false,
      details: `${errorCount} type error(s):\n${stderr.slice(0, 1000)}`,
    };
  }
}

async function checkTestsPass(worktreePath: string): Promise<GateCheck> {
  // Check if package.json has a test script
  const pkgPath = join(worktreePath, "package.json");
  if (!existsSync(pkgPath)) {
    return {
      name: "Tests pass",
      passed: true,
      details: "No package.json — skipped",
    };
  }

  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    if (!pkg.scripts?.test || pkg.scripts.test.includes("no test specified")) {
      return {
        name: "Tests pass",
        passed: true,
        details: "No test script defined — skipped",
      };
    }
  } catch {
    return {
      name: "Tests pass",
      passed: true,
      details: "Could not read package.json — skipped",
    };
  }

  try {
    const { stdout } = await exec("npm", ["test", "--", "--passWithNoTests"], {
      cwd: worktreePath,
      timeout: 300_000,
    });
    return {
      name: "Tests pass",
      passed: true,
      details: `Tests passed:\n${stdout.slice(-500)}`,
    };
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr || "";
    return {
      name: "Tests pass",
      passed: false,
      details: `Tests failed:\n${stderr.slice(0, 1000)}`,
    };
  }
}

async function checkAcceptanceCriteria(
  worktreePath: string,
  baseBranch: string,
  criteria: string[],
  agentOutput: string,
  projectId?: string
): Promise<GateCheck> {
  if (criteria.length === 0) {
    return {
      name: "Acceptance criteria",
      passed: true,
      details: "No acceptance criteria defined — skipped",
    };
  }

  // Get diff for AI validation
  let diff = "";
  try {
    const { stdout } = await exec(
      "git",
      ["diff", `${baseBranch}..HEAD`],
      { cwd: worktreePath }
    );
    diff = stdout;
  } catch {
    diff = "";
  }

  // When there are no code changes, provide a clear message instead of an error
  if (!diff.trim()) {
    diff = "No code changes — agent reports work was already present in the codebase.";
  }

  const result = await validateAcceptanceCriteria(criteria, diff, agentOutput, projectId);

  const unmet = result.criteriaResults.filter((c) => !c.met);
  if (!result.passed || unmet.length > 0) {
    return {
      name: "Acceptance criteria",
      passed: false,
      details: [
        result.details,
        "",
        "Unmet criteria:",
        ...unmet.map((c) => `  - ${c.criterion}: ${c.explanation}`),
      ].join("\n"),
    };
  }

  return {
    name: "Acceptance criteria",
    passed: true,
    details: result.details,
  };
}

// ── Main quality gate runner ────────────────────────────────────────

export async function runQualityGate(params: {
  sessionId: string;
  ticketKey: string;
  projectId: string;
  worktreePath: string;
  baseBranch: string;
  acceptanceCriteria: string[];
  agentOutput: string;
  summary: string;
}): Promise<QualityGateResult> {
  const checks: GateCheck[] = [];

  // Run checks in order — stop on first required failure
  const commitCheck = await checkBranchHasCommits(
    params.worktreePath,
    params.baseBranch
  );
  checks.push(commitCheck);
  if (!commitCheck.passed) {
    // No commits — check if AC is already met on the base branch
    // Skip tsc/test checks (no code changed), go straight to AC validation
    const acCheck = await checkAcceptanceCriteria(
      params.worktreePath,
      params.baseBranch,
      params.acceptanceCriteria,
      params.agentOutput,
      params.projectId
    );
    checks.push(acCheck);

    if (acCheck.passed) {
      // AC met with zero changes — this is "already done"
      const decision = await decide({
        projectId: params.projectId,
        event: "quality_gate",
        ticketKey: params.ticketKey,
        question:
          "The agent made no code changes, but acceptance criteria appear to be already met by existing code on the base branch. Should this ticket be marked as Done without a PR?",
        data: {
          checks: checks.map((c) => ({
            name: c.name,
            passed: c.passed,
            details: c.details.slice(0, 500),
          })),
          summary: params.summary,
        },
      });

      if (decision.action === "approve") {
        return finalize(params, checks, true, decision.reasoning, true); // alreadyDone=true
      }
    }

    // AC not met or Lyra rejected — real failure
    return finalize(params, checks, false, "No commits and acceptance criteria not met on base branch");
  }

  const tscCheck = await checkTypeScriptCompiles(params.worktreePath);
  checks.push(tscCheck);

  const testCheck = await checkTestsPass(params.worktreePath);
  checks.push(testCheck);

  const acCheck = await checkAcceptanceCriteria(
    params.worktreePath,
    params.baseBranch,
    params.acceptanceCriteria,
    params.agentOutput,
    params.projectId
  );
  checks.push(acCheck);

  // All checks done — ask Lyra for final verdict
  const allPassed = checks.every((c) => c.passed);

  const decision = await decide({
    projectId: params.projectId,
    event: "quality_gate",
    ticketKey: params.ticketKey,
    question: allPassed
      ? "All quality gate checks passed. Should this work be approved for QA review?"
      : "Some quality gate checks failed. Should this ticket be sent back for rework?",
    data: {
      checks: checks.map((c) => ({
        name: c.name,
        passed: c.passed,
        details: c.details.slice(0, 500),
      })),
      summary: params.summary,
    },
  });

  const passed = allPassed && decision.action === "approve";
  return finalize(params, checks, passed, decision.reasoning);
}

async function finalize(
  params: {
    sessionId: string;
    ticketKey: string;
    projectId: string;
    summary: string;
  },
  checks: GateCheck[],
  passed: boolean,
  reasoning: string,
  alreadyDone = false
): Promise<QualityGateResult> {
  // Persist gate run
  await prisma.qualityGateRun.create({
    data: {
      sessionId: params.sessionId,
      ticketKey: params.ticketKey,
      projectId: params.projectId,
      passed,
      checks: JSON.stringify(checks),
      reasoning,
    },
  });

  // Emit appropriate event
  const eventData = {
    ticketKey: params.ticketKey,
    projectId: params.projectId,
    sessionId: params.sessionId,
    passed,
    checks,
    reasoning,
  };

  if (passed) {
    lyraEvents.emit("gate:passed", eventData);
  } else {
    lyraEvents.emit("gate:failed", eventData);
  }

  return { passed, alreadyDone, checks, reasoning };
}
