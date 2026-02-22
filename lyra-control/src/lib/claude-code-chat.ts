/**
 * Claude Code CLI chat — shared utility for routing AI calls through the
 * Claude Code CLI (Max subscription) instead of OpenRouter.
 *
 * Used by any module that needs to support `claude-code/*` model IDs.
 */

import { spawn } from "child_process";

/** Accepts any message shape that has role + content (compatible with openrouter ChatMessage) */
export type ChatMessage = {
  role: string;
  content: string | null;
};

const CLAUDE_CODE_MODEL_MAP: Record<string, string> = {
  "claude-code/opus-4.6": "claude-opus-4-6",
  "claude-code/sonnet-4.6": "claude-sonnet-4-6",
  "claude-code/haiku-4.5": "claude-haiku-4-5",
  "claude-code/opus": "opus",
  "claude-code/sonnet": "sonnet",
  "claude-code/haiku": "haiku",
};

/**
 * Returns true if the model ID should be routed through Claude Code CLI.
 */
export function isClaudeCodeModel(model: string): boolean {
  return model.startsWith("claude-code/");
}

/**
 * Resolve a `claude-code/*` model ID to the CLI `--model` argument.
 */
export function resolveCliModel(model: string): string {
  return CLAUDE_CODE_MODEL_MAP[model] || "sonnet";
}

/**
 * Call Claude Code CLI with the given messages. Returns the raw text content.
 *
 * - Pipes user content via stdin to avoid shell argument length limits
 * - Uses `--system-prompt` for the system message
 * - Unsets CLAUDECODE env var to avoid nested session detection
 * - Uses `--dangerously-skip-permissions` for headless operation
 */
export async function chatViaClaude(
  messages: ChatMessage[],
  model: string,
  timeoutMs: number = 600_000
): Promise<{ content: string; durationMs: number; cliModel: string }> {
  const cliModel = resolveCliModel(model);

  const systemMsg = messages.find((m) => m.role === "system");
  const userMsgs = messages.filter((m) => m.role !== "system");
  const userContent = userMsgs.map((m) => m.content || "").join("\n\n");

  const start = Date.now();

  // Unset CLAUDECODE env var to avoid nested session detection
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const content = await new Promise<string>((resolve, reject) => {
    const args = [
      "-p", "-",
      "--model", cliModel,
      "--output-format", "json",
      "--max-turns", "1",
      "--dangerously-skip-permissions",
    ];
    if (systemMsg?.content) {
      args.push("--system-prompt", systemMsg.content);
    }

    const child = spawn("claude", args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    // Write user content to stdin, then close it
    child.stdin.write(userContent);
    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Claude Code request timed out after 10 minutes. Try a smaller model."));
    }, timeoutMs);

    child.on("error", (e: Error) => {
      clearTimeout(timer);
      reject(new Error(`Claude Code CLI error: ${e.message}`));
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude Code CLI error (exit ${code}): ${stderr.trim() || "unknown error"}`));
        return;
      }
      // Parse JSON envelope from --output-format json
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result || parsed.content || parsed.text || stdout.trim());
      } catch {
        resolve(stdout.trim());
      }
    });
  });

  return {
    content,
    durationMs: Date.now() - start,
    cliModel,
  };
}
