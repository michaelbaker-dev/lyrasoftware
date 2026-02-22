/**
 * Launch Script Generator — AI analyzes CodebaseAnalysis to produce
 * a stack-appropriate launch script via Handlebars template.
 *
 * Includes self-healing: validates the generated script and retries
 * with LLM-driven fixes if commands fail.
 */

import { chat } from "./openrouter";
import { isClaudeCodeModel, chatViaClaude } from "./claude-code-chat";
import { readFileSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import Handlebars from "handlebars";
import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import { upsertTriageLog } from "./failure-analyzer";
import { createIssue, getBoardsForProject, getSprints, moveIssuesToSprint } from "./jira";
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
    startupTime?: number;
    portEnvVar?: string;
  }[];
  envSetup?: string;
  prelaunchCommands?: string[];
  serviceStartCommands?: { name: string; command: string; readyCheck?: string; readyTimeout?: number }[];
  testingInstructions?: string[];
}

export interface ValidationResult {
  success: boolean;
  failedStep?: string;
  error?: string;
}

export type LaunchErrorClass = "config_fixable" | "project_fixable";

export interface LaunchErrorClassification {
  errorClass: LaunchErrorClass;
  category: string;
  summary: string;
  suggestedFix: string;
}

export interface TriageResult {
  category: string;
  action: string;
  summary: string;
  suggestedFix: string;
  linkedBugKey?: string;
}

export interface GenerateAndValidateResult {
  scriptPath: string;
  config: LaunchConfig;
  attempts: number;
  validated: boolean;
  lastError?: string;
  triaged?: boolean;
  triageResult?: TriageResult;
}

// ── Model Selection ─────────────────────────────────────────────────

async function getLaunchModel(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "model_launch" },
  });
  return setting?.value || "anthropic/claude-haiku-4-5";
}

// ── Analyze Launch Config via AI ──────────────────────────────────────

const LAUNCH_SYSTEM_PROMPT = `You are an expert DevOps engineer analyzing a codebase to generate a complete local launch configuration. Your goal is to produce a config that starts EVERYTHING needed — from external services to the app itself — so the user can go from zero to running with one command.

Return ONLY valid JSON (no markdown fences) matching this structure:
{
  "serviceStartCommands": [
    { "name": "description", "command": "start command", "readyCheck": "check command", "readyTimeout": 30 }
  ],
  "installCommands": [{ "name": "description", "command": "shell command", "cwd": "optional subdir" }],
  "prelaunchCommands": ["shell commands run before starting app processes"],
  "processes": [
    { "name": "process name", "command": "shell command", "cwd": "optional subdir", "port": 3000, "portEnvVar": "PORT", "healthUrl": "http://localhost:3000", "startupTime": 5 }
  ],
  "envSetup": "optional bash export commands",
  "testingInstructions": ["Step 1: Open http://localhost:3000 in your browser", "Step 2: ..."]
}

## Service Start Commands
- If docker-compose services are detected, use "docker compose up -d <service>" for each needed service
- If a database is needed but no docker-compose exists, include a readyCheck to verify it's running (e.g. "pg_isready -h localhost" for PostgreSQL, "redis-cli ping" for Redis, "mongosh --eval 'db.runCommand({ping:1})' --quiet" for MongoDB, "mysqladmin ping -h localhost" for MySQL)
- Set readyTimeout appropriately — databases typically need 10-30s to start, Redis is near-instant
- Always include a readyCheck for each service so the script can wait for it

## Port Handling
- For each process that uses a port, set "port" AND "portEnvVar" (the env var that controls the port, e.g. "PORT", "VITE_PORT", "API_PORT")
- The launch script will automatically detect port conflicts: if a port is already in use, it increments the port and sets the env var accordingly.
- Do NOT hardcode ports into commands — use env vars so the script can adjust them. Example: use {"command": "npm run dev", "port": 3000, "portEnvVar": "PORT"} not {"command": "PORT=3000 npm run dev", "port": 3000}

## Install Commands
- Use the correct package manager detected for the project
- For monorepos, install in each workspace that needs it
- For Go: "go mod download"; for Rust: handled by cargo build; for Python: "pip install -r requirements.txt" or "poetry install"

## Pre-launch Commands
- Include database migrations if the project uses an ORM (e.g. "npx prisma migrate deploy", "npx prisma generate", "python manage.py migrate")
- Include build steps if the project requires compilation before running (e.g. "go build -o ./bin/server ./cmd/server", "cargo build", "npm run build")
- Include database seeding if a seed script exists

## Processes
- Detect ALL processes: frontend, backend, API, workers, etc.
- For Node.js: prefer "npm run dev" or the dev script from package.json
- For Go: run the compiled binary (e.g. "./bin/server") or "go run ./cmd/server"
- For Rust: "cargo run" or run the compiled binary
- For Python: "python manage.py runserver", "uvicorn main:app", "flask run", etc.
- Set healthUrl for HTTP services only
- Set startupTime (seconds) for slow-starting processes (default 5). Go/Rust binaries: 2-3s. Node dev servers: 5-10s. Java/heavy frameworks: 15-30s.
- Do NOT include "cd" in commands — use "cwd" field instead

## Testing Instructions
- Include 2-5 concrete steps the user should take to verify the app works
- For web apps: "Open http://localhost:PORT in your browser"
- For APIs: "Run: curl http://localhost:PORT/api/health" or a specific endpoint
- For CLI tools: "Run: ./bin/tool --help"
- If there's a test command: "Run: npm test" or equivalent
- Be specific to THIS project — reference actual routes, pages, or endpoints from the analysis

## Path Rules
- Scripts prefixed with "subdirname:" (e.g. "server:dev") are NOT root scripts — they come from that subdirectory's package.json. Use unprefixed script with cwd.
- PATH ACCURACY IS CRITICAL for TypeScript: outDir path mapping preserves directory structure relative to rootDir. Trace carefully.
- Prefer package.json scripts over raw commands.
- Use detected port hints — do not guess defaults.`;

function buildAnalysisPrompt(analysis: CodebaseAnalysis): string {
  let prompt = `Analyze this project and determine launch configuration:

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

  if (analysis.serviceRequirements?.length)
    prompt += `\n\nDetected External Service Requirements: ${JSON.stringify(analysis.serviceRequirements)}`;

  if (analysis.dockerComposeServices?.length)
    prompt += `\n\nDocker Compose Services (available to start): ${JSON.stringify(analysis.dockerComposeServices)}`;

  if (analysis.portHints && Object.keys(analysis.portHints).length > 0)
    prompt += `\n\nDetected Port Configuration: ${JSON.stringify(analysis.portHints)}`;

  if (analysis.connectionStrings && Object.keys(analysis.connectionStrings).length > 0)
    prompt += `\n\nConnection Strings (from .env.example): ${JSON.stringify(analysis.connectionStrings)}`;

  if (analysis.prismaProvider)
    prompt += `\n\nPrisma Datasource Provider: ${analysis.prismaProvider}`;

  if (analysis.setupInstructions)
    prompt += `\n\nREADME Setup Instructions:\n${analysis.setupInstructions}`;

  return prompt;
}

function parseConfigResponse(rawContent: string): LaunchConfig {
  let jsonStr = rawContent.trim();
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1].trim();
  const parsed = JSON.parse(jsonStr);

  // Normalize per-process fields
  const processes = Array.isArray(parsed.processes)
    ? parsed.processes.map((p: Record<string, unknown>) => ({
        name: p.name,
        command: p.command,
        cwd: p.cwd || undefined,
        port: typeof p.port === "number" ? p.port : undefined,
        healthUrl: p.healthUrl || undefined,
        startupTime: typeof p.startupTime === "number" ? p.startupTime : undefined,
        portEnvVar: typeof p.portEnvVar === "string" ? p.portEnvVar : undefined,
      }))
    : [];

  return {
    installCommands: Array.isArray(parsed.installCommands) ? parsed.installCommands : [],
    processes,
    envSetup: parsed.envSetup || undefined,
    prelaunchCommands: Array.isArray(parsed.prelaunchCommands) ? parsed.prelaunchCommands : undefined,
    serviceStartCommands: Array.isArray(parsed.serviceStartCommands) ? parsed.serviceStartCommands : undefined,
    testingInstructions: Array.isArray(parsed.testingInstructions) ? parsed.testingInstructions : undefined,
  };
}

export async function analyzeLaunchConfig(
  projectId: string,
  analysis: CodebaseAnalysis,
  modelOverride?: string
): Promise<LaunchConfig> {
  const model = modelOverride || await getLaunchModel();
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
    { role: "system", content: LAUNCH_SYSTEM_PROMPT },
    { role: "user", content: buildAnalysisPrompt(analysis) },
  ];

  let rawContent: string;
  if (isClaudeCodeModel(model)) {
    const result = await chatViaClaude(messages, model);
    rawContent = result.content;
  } else {
    const response = await chat(messages, model, { projectId, category: "launch-analysis" });
    rawContent = response.choices[0]?.message?.content || "";
  }

  return parseConfigResponse(rawContent);
}

// ── Fix Launch Config via AI ──────────────────────────────────────────

export async function fixLaunchConfig(
  projectId: string,
  analysis: CodebaseAnalysis,
  previousConfig: LaunchConfig,
  failedStep: string,
  errorOutput: string,
  modelOverride?: string
): Promise<LaunchConfig> {
  const model = modelOverride || await getLaunchModel();
  const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
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
  ];

  let rawContent: string;
  if (isClaudeCodeModel(model)) {
    const result = await chatViaClaude(messages, model);
    rawContent = result.content;
  } else {
    const response = await chat(messages, model, { projectId, category: "launch-analysis" });
    rawContent = response.choices[0]?.message?.content || "";
  }

  return parseConfigResponse(rawContent);
}

// ── Validate Launch Script ────────────────────────────────────────────

export async function validateLaunchScript(
  _scriptPath: string,
  projectPath: string,
  config: LaunchConfig
): Promise<ValidationResult> {
  // 0. Validate service start commands
  for (const svc of config.serviceStartCommands ?? []) {
    const parts = svc.command.split(/\s+/);
    try {
      await execAsync(parts[0], parts.slice(1), { cwd: projectPath, timeout: 10_000 });
    } catch { /* non-fatal — service may already be running */ }

    if (svc.readyCheck) {
      const checkParts = svc.readyCheck.split(/\s+/);
      const timeout = (svc.readyTimeout ?? 30) * 1000;
      const start = Date.now();
      let ready = false;
      while (Date.now() - start < timeout) {
        try {
          await execAsync(checkParts[0], checkParts.slice(1), { timeout: 5_000 });
          ready = true;
          break;
        } catch { /* not ready yet */ }
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!ready) {
        return {
          success: false,
          failedStep: `service-ready: ${svc.name}`,
          error: `${svc.name} did not become ready within ${svc.readyTimeout ?? 30}s`,
        };
      }
    }
  }

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
    const result = await checkProcessStarts(parts[0], parts.slice(1), cwd, (proc.startupTime ?? 5) * 1000);
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

/** Start a process and check it doesn't crash within the given timeout */
async function checkProcessStarts(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number = 5_000
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

    // If process is still running after timeout, it started successfully
    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGTERM");
      } catch {
        // Process may have already exited
      }
      resolve({ success: true });
    }, timeoutMs);
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
  analysis: CodebaseAnalysis,
  modelOverride?: string
): Promise<{ scriptPath: string; config: LaunchConfig }> {
  const config = await analyzeLaunchConfig(projectId, analysis, modelOverride);
  const projectName =
    projectPath.split("/").filter(Boolean).pop() || "project";
  const script = renderLaunchScript(config, projectName);

  const scriptPath = join(projectPath, "lyra-launch.sh");
  writeFileSync(scriptPath, script, "utf-8");
  chmodSync(scriptPath, 0o755);

  return { scriptPath, config };
}

// ── Error Classification ──────────────────────────────────────────────

const PROJECT_FIXABLE_PATTERNS: {
  pattern: RegExp;
  category: string;
  summary: (match: RegExpMatchArray, error: string) => string;
  suggestedFix: (match: RegExpMatchArray, error: string) => string;
}[] = [
  {
    pattern: /node-gyp rebuild[\s\S]*(?:error C\d+|fatal error|c\+\+|g\+\+|clang)/i,
    category: "dependency_issue",
    summary: (_m, error) => {
      const pkg = error.match(/(\S+)@[\d.]+/)?.[1] || "native module";
      return `Native module "${pkg}" failed to compile`;
    },
    suggestedFix: (_m, error) => {
      const pkg = error.match(/(\S+)@[\d.]+/)?.[1];
      return pkg
        ? `Update "${pkg}" to a version with prebuilt binaries for your Node version: npm install ${pkg}@latest`
        : "Update the native dependency to a version compatible with your Node version";
    },
  },
  {
    pattern: /prebuild-install[\s\S]*(?:no prebuilt|not found|unsupported)/i,
    category: "dependency_issue",
    summary: (_m, error) => {
      const pkg = error.match(/(\S+)@[\d.]+/)?.[1] || "native module";
      return `No prebuilt binaries available for "${pkg}"`;
    },
    suggestedFix: (_m, error) => {
      const pkg = error.match(/(\S+)@[\d.]+/)?.[1];
      return pkg
        ? `Update "${pkg}" to a version with prebuilt binaries: npm install ${pkg}@latest`
        : "Update the native dependency to a newer version with prebuilt binaries";
    },
  },
  {
    pattern: /ERESOLVE[\s\S]*(?:peer dep|could not resolve|conflicting)/i,
    category: "dependency_issue",
    summary: () => "Peer dependency conflict prevents installation",
    suggestedFix: (_m, error) => {
      const conflict = error.match(/(?:peer dep|requires).*?(\S+@\S+)/i)?.[1];
      return conflict
        ? `Resolve peer dependency conflict involving ${conflict}. Run: npm ls --all to identify conflicting versions, then update package.json accordingly`
        : "Resolve peer dependency conflicts in package.json. Run: npm ls --all to identify conflicting versions";
    },
  },
  {
    pattern: /engines?[\s\S]*node[\s\S]*(?:not compatible|does not satisfy|unsupported)/i,
    category: "dependency_issue",
    summary: () => "Node.js engine version mismatch",
    suggestedFix: (_m, error) => {
      const required = error.match(/engines?.*"node":\s*"([^"]+)"/)?.[1];
      return required
        ? `Update the "engines.node" field in package.json to include the current Node version, or install a compatible Node version (required: ${required})`
        : 'Update the "engines.node" field in package.json to be compatible with the current Node version';
    },
  },
  {
    pattern: /\.h:\s*No such file|fatal error:[\s\S]*\.h[\s\S]*not found|Cannot find[\s\S]*header/i,
    category: "env_issue",
    summary: (_m, error) => {
      const header = error.match(/([\w./]+\.h)/)?.[1] || "system header";
      return `Missing system header file: ${header}`;
    },
    suggestedFix: (_m, error) => {
      const header = error.match(/([\w./]+\.h)/)?.[1];
      return header
        ? `Install the system development package that provides "${header}". On macOS: xcode-select --install. On Ubuntu: apt-get install build-essential`
        : "Install required system development libraries. On macOS: xcode-select --install. On Ubuntu: apt-get install build-essential";
    },
  },
];

/**
 * Classify a validation error as config-fixable or project-fixable.
 * Returns null if no pattern matches (assumed config-fixable).
 */
export function classifyLaunchError(error: string): LaunchErrorClassification | null {
  for (const { pattern, category, summary, suggestedFix } of PROJECT_FIXABLE_PATTERNS) {
    const match = error.match(pattern);
    if (match) {
      return {
        errorClass: "project_fixable",
        category,
        summary: summary(match, error),
        suggestedFix: suggestedFix(match, error),
      };
    }
  }
  return null;
}

/**
 * Create a Jira Bug ticket for a project-fixable launch error and log to TriageLog.
 */
async function triageLaunchFailure(
  projectId: string,
  projectPath: string,
  classification: LaunchErrorClassification,
  errorOutput: string,
): Promise<TriageResult> {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const jiraKey = project.jiraKey;

  // Create Jira Bug
  const bugSummary = `[Launch Validation] ${classification.summary}`;
  const bugDescription = [
    `Category: ${classification.category}`,
    `Suggested Fix: ${classification.suggestedFix}`,
    `Project Path: ${projectPath}`,
    "",
    "--- Error Output (last 3000 chars) ---",
    errorOutput.slice(-3000),
  ].join("\n");

  let linkedBugKey: string | undefined;
  try {
    const issue = await createIssue(jiraKey, "Bug", bugSummary, bugDescription);
    linkedBugKey = issue?.key;

    // Move to active sprint if one exists
    if (linkedBugKey && project.jiraBoardId) {
      try {
        const sprintsResult = await getSprints(project.jiraBoardId, "active");
        const activeSprint = sprintsResult?.values?.[0];
        if (activeSprint) {
          await moveIssuesToSprint(activeSprint.id, [linkedBugKey]);
        }
      } catch {
        // Non-critical: sprint move failed
      }
    }
  } catch (e) {
    console.error("[triageLaunchFailure] Failed to create Jira bug:", (e as Error).message);
  }

  // Persist TriageLog entry (deduped)
  const action = "create_bug";
  await upsertTriageLog({
    projectId,
    ticketKey: linkedBugKey || "UNKNOWN",
    ticketSummary: classification.summary,
    source: "launch_validation",
    category: classification.category,
    action,
    summary: classification.summary,
    suggestedFix: classification.suggestedFix,
    actionTaken: linkedBugKey
      ? `Created bug ticket ${linkedBugKey}`
      : "Failed to create bug ticket",
    linkedBugKey,
    confidence: 1.0,
    resolution: "open",
    attemptCount: 1,
  });

  return {
    category: classification.category,
    action,
    summary: classification.summary,
    suggestedFix: classification.suggestedFix,
    linkedBugKey,
  };
}

// ── Self-Healing Pipeline ─────────────────────────────────────────────

export async function generateAndValidateLaunchScript(
  projectId: string,
  projectPath: string,
  analysis: CodebaseAnalysis,
  maxRetries: number = 3,
  modelOverride?: string
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
      config = await analyzeLaunchConfig(projectId, analysis, modelOverride);
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
        lastError!,
        modelOverride
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

    // Classify the error after first failure — short-circuit if project-fixable
    if (attempt === 1 && lastError) {
      const classification = classifyLaunchError(lastError);
      if (classification) {
        lyraEvents.emit("launch:progress", {
          projectId,
          step: "triaging",
          attempt,
          maxRetries,
          triageInfo: {
            category: classification.category,
            summary: classification.summary,
            suggestedFix: classification.suggestedFix,
          },
        });

        const triageResult = await triageLaunchFailure(
          projectId,
          projectPath,
          classification,
          lastError,
        );

        lyraEvents.emit("launch:progress", {
          projectId,
          step: "failed",
          attempt,
          maxRetries,
          error: lastError,
          triageInfo: {
            category: triageResult.category,
            summary: triageResult.summary,
            suggestedFix: triageResult.suggestedFix,
            linkedBugKey: triageResult.linkedBugKey,
          },
        });

        return {
          scriptPath,
          config,
          attempts: attempt,
          validated: false,
          lastError,
          triaged: true,
          triageResult,
        };
      }
    }
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
