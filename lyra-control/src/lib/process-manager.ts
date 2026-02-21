/**
 * Process Manager — tracks launched app processes.
 * HMR-safe singleton via globalThis (same pattern as dispatcher.ts).
 */

import { spawn, type ChildProcess } from "child_process";
import { lyraEvents } from "./lyra-events";

// ── Types ─────────────────────────────────────────────────────────────

export interface LaunchedApp {
  projectId: string;
  process: ChildProcess;
  scriptPath: string;
  startedAt: Date;
  output: string[];
  ports: number[];
}

// ── HMR-safe singleton ───────────────────────────────────────────────

const globalForPM = globalThis as unknown as {
  __launchedApps: Map<string, LaunchedApp> | undefined;
};

const apps: Map<string, LaunchedApp> =
  globalForPM.__launchedApps ?? new Map();
if (process.env.NODE_ENV !== "production") {
  globalForPM.__launchedApps = apps;
}

const MAX_OUTPUT_LINES = 500;

// ── Public API ────────────────────────────────────────────────────────

export function launchApp(
  projectId: string,
  scriptPath: string,
  cwd: string,
  ports: number[]
): void {
  // Stop existing instance if running
  if (apps.has(projectId)) {
    stopApp(projectId);
  }

  const proc = spawn("bash", [scriptPath], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  const app: LaunchedApp = {
    projectId,
    process: proc,
    scriptPath,
    startedAt: new Date(),
    output: [],
    ports,
  };

  const appendLine = (line: string) => {
    app.output.push(line);
    if (app.output.length > MAX_OUTPUT_LINES) {
      app.output.shift();
    }
    lyraEvents.emit("app:output", { projectId, line });
  };

  proc.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) appendLine(line);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n").filter(Boolean);
    for (const line of lines) appendLine(`[stderr] ${line}`);
  });

  proc.on("exit", (code) => {
    appendLine(`Process exited with code ${code}`);
    apps.delete(projectId);
    lyraEvents.emit("app:stopped", { projectId });
  });

  apps.set(projectId, app);
  lyraEvents.emit("app:launched", { projectId, ports });
}

export function stopApp(projectId: string): boolean {
  const app = apps.get(projectId);
  if (!app) return false;

  try {
    // SIGTERM lets the bash trap handle cleanup
    app.process.kill("SIGTERM");
  } catch {
    // Process may already be dead
  }

  apps.delete(projectId);
  lyraEvents.emit("app:stopped", { projectId });
  return true;
}

export function isAppRunning(projectId: string): boolean {
  const app = apps.get(projectId);
  if (!app) return false;
  // Check if process is still alive
  try {
    process.kill(app.process.pid!, 0);
    return true;
  } catch {
    apps.delete(projectId);
    return false;
  }
}

export function getAppStatus(projectId: string): {
  running: boolean;
  ports: number[];
  startedAt: Date | null;
  outputTail: string[];
} {
  const app = apps.get(projectId);
  if (!app || !isAppRunning(projectId)) {
    return { running: false, ports: [], startedAt: null, outputTail: [] };
  }
  return {
    running: true,
    ports: app.ports,
    startedAt: app.startedAt,
    outputTail: app.output.slice(-50),
  };
}
