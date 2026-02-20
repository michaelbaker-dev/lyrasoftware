/**
 * Launch Script Generator — AI analyzes CodebaseAnalysis to produce
 * a stack-appropriate launch script via Handlebars template.
 *
 * Includes self-healing: validates the generated script and retries
 * with LLM-driven fixes if commands fail.
 */

import { chat } from "./openrouter";
import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import Handlebars from "handlebars";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import type { CodebaseAnalysis } from "./codebase-analyzer";

const execAsync = promisify(execFile);

// ── Types ─────────────────────────────────────────────────────────────

export interface LaunchConfig {
  installCommands: { name: string; command: string; cwd?: string }[];
  processes: {
    name: string;
    command: string;
    cwd?: string;
    port?: number;
    healthUrl?: string;
  }[];
  envSetup?: string;
  prelaunchCommands?: string[];
}

export interface ValidationResult {
  success: boolean;
  failedStep?: string;
  error?: string;
}

export interface GenerateAndValidateResult {
  scriptPath: string;
  config: LaunchConfig;
  attempts: number;
  validated: boolean;
  lastError?: string;
}

// ── Model Selection ─────────────────────────────────────────────────

async function getLaunchModel(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "model_launch" },
  });
  return setting?.value || "anthropic/claude-haiku-4-5";
}

// ── Analyze Launch Config via AI ──────────────────────────────────────

const LAUNCH_SYSTEM_PROMPT = `You are analyzing a codebase to determine how to launch it locally. Given the project analysis data, determine the correct install and launch commands.

Return ONLY valid JSON (no markdown fences) matching this exact structure:
{
  "installCommands": [{ "name": "description", "command": "shell command", "cwd": "optional subdir" }],
  "processes": [{ "name": "process name", "command": "shell command", "cwd": "optional subdir", "port": 3000, "healthUrl": "http://localhost:3000" }],
  "envSetup": "optional bash commands for env setup",
  "prelaunchCommands": ["optional pre-launch shell commands"]
}

Rules:
- Detect ALL processes needed (frontend, backend, database, etc.)
- Use the correct package manager (npm, pnpm, yarn, cargo, pip, go, etc.)
- For monorepos, include install + start commands for each workspace
- Set healthUrl only for HTTP services (port-based health check)
- If the project has separate frontend/backend dirs, set cwd for each
- Include database migrations in prelaunchCommands if detected
- Do NOT include "cd" in commands — use "cwd" field instead
- PATH ACCURACY IS CRITICAL: TypeScript outDir path mapping preserves the directory structure relative to rootDir. Example: if rootDir is "src" and outDir is "dist/server", then "src/server/index.ts" compiles to "dist/server/server/index.js" (the "server" subdir is preserved under outDir). Never guess — always trace: strip rootDir prefix from source path, prepend outDir.
- Prefer using package.json scripts over raw "node <path>" commands.
- IMPORTANT: Scripts prefixed with "subdirname:" (e.g. "server:start", "server:dev") are NOT root scripts — they come from that subdirectory's own package.json. To run them, set "cwd" to the subdirectory and use the unprefixed script name. Example: if you see "server:dev": "node --watch src/index.js", use {"command": "npm run dev", "cwd": "server"}, NOT "npm run server:dev".
- Check the port numbers in the source code / config — do not assume defaults. If the code says PORT=3001, use 3001.`;

function buildAnalysisPrompt(analysis: CodebaseAnalysis): string {
  return `Analyze this project and determine launch configuration:

Framework: ${analysis.framework}
Language: ${analysis.language}
Package Manager: ${analysis.packageManager}
Monorepo Type: ${analysis.monorepoType || "none"}

Scripts: ${JSON.stringify(analysis.scripts)}

Entry Points: ${JSON.stringify(analysis.entryPoints)}

Key Dependencies: ${JSON.stringify(analysis.keyDependencies)}
Dev Dependencies: ${JSON.stringify(analysis.devDependencies)}

Directory Overview:
${analysis.directoryOverview}

Config Summary: ${JSON.stringify(analysis.configSummary)}

Environment Variables: ${JSON.stringify(analysis.envVars)}

Build Output Directory: ${analysis.buildOutput || "unknown"}`;
}

function parseConfigResponse(rawContent: string): LaunchConfig {
  let jsonStr = rawContent.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  return JSON.parse(jsonStr) as LaunchConfig;
}

export async function analyzeLaunchConfig(
  projectId: string,
  analysis: CodebaseAnalysis
): Promise<LaunchConfig> {
  const model = await getLaunchModel();
  const response = await chat(
    [
      { role: "system", content: LAUNCH_SYSTEM_PROMPT },
      { role: "user", content: buildAnalysisPrompt(analysis) },
    ],
    model,
    { projectId, category: "launch-analysis" }
  );

  const rawContent = response.choices[0]?.message?.content || "";
  return parseConfigResponse(rawContent);
}

// ── Fix Launch Config via AI ──────────────────────────────────────────

export async function fixLaunchConfig(
  projectId: string,
  analysis: CodebaseAnalysis,
  previousConfig: LaunchConfig,
  failedStep: string,
  errorOutput: string
): Promise<LaunchConfig> {
  const model = await getLaunchModel();
  const response = await chat(
    [
      { role: "system", content: LAUNCH_SYSTEM_PROMPT },
      {
        role: "user",
        content: `${buildAnalysisPrompt(analysis)}

The previous launch config caused an error:

Previous config: ${JSON.stringify(previousConfig)}

Error during "${failedStep}":
${errorOutput.slice(-2000)}

Fix the configuration to resolve this error. Return the corrected full JSON config.`,
      },
    ],
    model,
    { projectId, category: "launch-analysis" }
  );

  const rawContent = response.choices[0]?.message?.content || "";
  return parseConfigResponse(rawContent);
}

// ── Validate Launch Script ────────────────────────────────────────────

export async function validateLaunchScript(
  _scriptPath: string,
  projectPath: string,
  config: LaunchConfig
): Promise<ValidationResult> {
  // 1. Validate install commands
  for (const cmd of config.installCommands) {
    const cwd = cmd.cwd ? join(projectPath, cmd.cwd) : projectPath;
    const parts = cmd.command.split(/\s+/);
    try {
      await execAsync(parts[0], parts.slice(1), {
        cwd,
        timeout: 60_000,
        env: { ...process.env, CI: "true" },
      });
    } catch (e) {
      const err = e as Error & { stderr?: string };
      return {
        success: false,
        failedStep: `install: ${cmd.name}`,
        error: err.stderr || err.message,
      };
    }
  }

  // 2. Validate prelaunch commands
  for (const cmd of config.prelaunchCommands ?? []) {
    const parts = cmd.split(/\s+/);
    try {
      await execAsync(parts[0], parts.slice(1), {
        cwd: projectPath,
        timeout: 30_000,
      });
    } catch (e) {
      const err = e as Error & { stderr?: string };
      return {
        success: false,
        failedStep: `prelaunch: ${cmd}`,
        error: err.stderr || err.message,
      };
    }
  }

  // 3. Validate each process starts without crashing
  for (const proc of config.processes) {
    const cwd = proc.cwd ? join(projectPath, proc.cwd) : projectPath;
    const parts = proc.command.split(/\s+/);
    const result = await checkProcessStarts(parts[0], parts.slice(1), cwd);
    if (!result.success) {
      return {
        success: false,
        failedStep: `process: ${proc.name}`,
        error: result.error,
      };
    }

    // 4. Health URL check if defined
    if (proc.healthUrl) {
      const healthOk = await checkHealthUrl(proc.healthUrl, proc.port);
      if (!healthOk.success) {
        return {
          success: false,
          failedStep: `health: ${proc.name} (${proc.healthUrl})`,
          error: healthOk.error,
        };
      }
    }
  }

  return { success: true };
}

/** Start a process and check it doesn't crash within 5 seconds */
async function checkProcessStarts(
  cmd: string,
  args: string[],
  cwd: string
): Promise<{ success: boolean; error?: string }> {
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
      detached: true,
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({ success: false, error: err.message });
    });

    child.on("exit", (code) => {
      if (code !== null && code !== 0) {
        resolve({
          success: false,
          error: stderr.slice(-2000) || `Process exited with code ${code}`,
        });
      }
    });

    // If process is still running after 5s, it started successfully
    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // Process may have already exited
      }
      resolve({ success: true });
    }, 5_000);
  });
}

/** Check a health URL with retries */
async function checkHealthUrl(
  url: string,
  port?: number
): Promise<{ success: boolean; error?: string }> {
  // Wait for the port to become available, then check URL
  const maxWait = 10_000;
  const interval = 1_000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (res.ok || res.status < 500) return { success: true };
    } catch {
      // Not ready yet
    }
    await new Promise((r) => setTimeout(r, interval));
  }

  return {
    success: false,
    error: `Health check failed: ${url} (port ${port ?? "unknown"}) did not respond within ${maxWait / 1000}s`,
  };
}

// ── Render Launch Script ──────────────────────────────────────────────

export function renderLaunchScript(
  config: LaunchConfig,
  projectName: string
): string {
  const templatePath = join(
    process.cwd(),
    "src",
    "templates",
    "lyra-launch.sh.hbs"
  );
  const templateSource = readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(templateSource);

  return template({ ...config, projectName });
}

// ── Simple Pipeline (kept for backward compat) ───────────────────────

export async function generateLaunchScript(
  projectId: string,
  projectPath: string,
  analysis: CodebaseAnalysis
): Promise<{ scriptPath: string; config: LaunchConfig }> {
  const config = await analyzeLaunchConfig(projectId, analysis);
  const projectName =
    projectPath.split("/").filter(Boolean).pop() || "project";
  const script = renderLaunchScript(config, projectName);

  const scriptPath = join(projectPath, "lyra-launch.sh");
  writeFileSync(scriptPath, script, "utf-8");
  chmodSync(scriptPath, 0o755);

  return { scriptPath, config };
}

// ── Self-Healing Pipeline ─────────────────────────────────────────────

export async function generateAndValidateLaunchScript(
  projectId: string,
  projectPath: string,
  analysis: CodebaseAnalysis,
  maxRetries: number = 3
): Promise<GenerateAndValidateResult> {
  const projectName =
    projectPath.split("/").filter(Boolean).pop() || "project";
  const scriptPath = join(projectPath, "lyra-launch.sh");

  let config: LaunchConfig | null = null;
  let lastError: string | undefined;
  let lastFailedStep: string | undefined;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Generate or fix config
    if (attempt === 1) {
      lyraEvents.emit("launch:progress", {
        projectId,
        step: "generating",
        attempt,
        maxRetries,
      });
      config = await analyzeLaunchConfig(projectId, analysis);
    } else {
      lyraEvents.emit("launch:progress", {
        projectId,
        step: "fixing",
        attempt,
        maxRetries,
        error: lastError,
      });
      config = await fixLaunchConfig(
        projectId,
        analysis,
        config!,
        lastFailedStep!,
        lastError!
      );
    }

    // Render and write script
    const script = renderLaunchScript(config, projectName);
    writeFileSync(scriptPath, script, "utf-8");
    chmodSync(scriptPath, 0o755);

    // Validate
    lyraEvents.emit("launch:progress", {
      projectId,
      step: "validating",
      attempt,
      maxRetries,
    });

    const result = await validateLaunchScript(scriptPath, projectPath, config);

    if (result.success) {
      lyraEvents.emit("launch:progress", {
        projectId,
        step: "success",
        attempt,
        maxRetries,
      });
      return { scriptPath, config, attempts: attempt, validated: true };
    }

    lastError = result.error;
    lastFailedStep = result.failedStep;
  }

  // All retries exhausted
  lyraEvents.emit("launch:progress", {
    projectId,
    step: "failed",
    attempt: maxRetries,
    maxRetries,
    error: lastError,
  });

  return {
    scriptPath,
    config: config!,
    attempts: maxRetries,
    validated: false,
    lastError,
  };
}
