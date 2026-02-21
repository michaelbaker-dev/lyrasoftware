/**
 * OpenRouter Coding Agent — a tool-loop agent that uses OpenRouter API
 * instead of the `claude` CLI. Enables non-Claude models (e.g. DeepSeek)
 * to execute coding tasks with file editing, command execution, etc.
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { join, resolve, relative, isAbsolute } from "path";
import { chat, type ChatMessage, type ToolDefinition, type ChatCostContext } from "./openrouter";

// ── Result Type ───────────────────────────────────────────────────────

export interface OpenRouterAgentResult {
  exitCode: number;       // 0 = success, 1 = failure
  output: string;         // Full conversation log for session.output
  cost: number;           // Accumulated cost from all API turns
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── Tool Definitions ──────────────────────────────────────────────────

const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Path is relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to project root" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write or create a file with the given content. Creates parent directories if needed. Path is relative to the project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to project root" },
          content: { type: "string", description: "Full file content to write" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Replace a specific string in a file. The old_string must appear exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to project root" },
          old_string: { type: "string", description: "Exact string to find and replace" },
          new_string: { type: "string", description: "Replacement string" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List files and directories at a path. Path is relative to project root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Directory path relative to project root (default: '.')" },
          recursive: { type: "boolean", description: "If true, list recursively (max 500 entries)" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "Execute a shell command in the project directory. Has a 60-second timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to execute" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search for a pattern across files using grep. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Search pattern (regex supported)" },
          glob: { type: "string", description: "Optional file glob filter (e.g. '*.ts', 'src/**/*.tsx')" },
        },
        required: ["pattern"],
      },
    },
  },
];

// ── Path Safety ───────────────────────────────────────────────────────

function safePath(worktreePath: string, filePath: string): string {
  // Reject absolute paths and path traversal
  if (isAbsolute(filePath)) {
    throw new Error(`Absolute paths not allowed: ${filePath}`);
  }
  const resolved = resolve(worktreePath, filePath);
  const rel = relative(worktreePath, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Path escapes worktree: ${filePath}`);
  }
  return resolved;
}

// ── Tool Execution ────────────────────────────────────────────────────

function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  worktreePath: string
): string {
  try {
    switch (toolName) {
      case "read_file": {
        const filePath = safePath(worktreePath, args.path as string);
        const content = readFileSync(filePath, "utf-8");
        // Truncate very large files
        if (content.length > 100_000) {
          return content.slice(0, 100_000) + "\n\n[... truncated — file exceeds 100KB]";
        }
        return content;
      }

      case "write_file": {
        const filePath = safePath(worktreePath, args.path as string);
        const dir = join(filePath, "..");
        mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, args.content as string, "utf-8");
        return `File written: ${args.path}`;
      }

      case "edit_file": {
        const filePath = safePath(worktreePath, args.path as string);
        const content = readFileSync(filePath, "utf-8");
        const oldStr = args.old_string as string;
        const newStr = args.new_string as string;
        const occurrences = content.split(oldStr).length - 1;
        if (occurrences === 0) {
          return `Error: old_string not found in ${args.path}`;
        }
        if (occurrences > 1) {
          return `Error: old_string found ${occurrences} times in ${args.path} — must be unique`;
        }
        writeFileSync(filePath, content.replace(oldStr, newStr), "utf-8");
        return `File edited: ${args.path}`;
      }

      case "list_directory": {
        const dirPath = safePath(worktreePath, (args.path as string) || ".");
        const recursive = args.recursive === true;

        if (recursive) {
          const entries: string[] = [];
          function walk(dir: string) {
            if (entries.length >= 500) return;
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
              const rel = relative(worktreePath, join(dir, entry.name));
              if (entry.isDirectory()) {
                entries.push(rel + "/");
                walk(join(dir, entry.name));
              } else {
                entries.push(rel);
              }
            }
          }
          walk(dirPath);
          return entries.join("\n") || "(empty directory)";
        }

        const entries = readdirSync(dirPath, { withFileTypes: true });
        return entries
          .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
          .join("\n") || "(empty directory)";
      }

      case "run_command": {
        const command = args.command as string;
        // Basic sanitization — block obvious shell escapes
        if (command.includes("rm -rf /") || command.includes(":(){ :|:& };:")) {
          return "Error: dangerous command blocked";
        }
        const output = execSync(command, {
          cwd: worktreePath,
          timeout: 60_000,
          maxBuffer: 1024 * 1024, // 1MB
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        // Truncate large outputs
        if (output.length > 50_000) {
          return output.slice(0, 50_000) + "\n\n[... truncated — output exceeds 50KB]";
        }
        return output || "(no output)";
      }

      case "search_files": {
        const pattern = args.pattern as string;
        const glob = args.glob as string | undefined;
        let cmd = `grep -rn --include='*' "${pattern.replace(/"/g, '\\"')}"`;
        if (glob) {
          cmd = `grep -rn --include='${glob.replace(/'/g, "\\'")}' "${pattern.replace(/"/g, '\\"')}"`;
        }
        cmd += " .";
        try {
          const output = execSync(cmd, {
            cwd: worktreePath,
            timeout: 30_000,
            maxBuffer: 512 * 1024,
            encoding: "utf-8",
            stdio: ["pipe", "pipe", "pipe"],
          });
          if (output.length > 30_000) {
            return output.slice(0, 30_000) + "\n\n[... truncated]";
          }
          return output || "(no matches)";
        } catch (err: unknown) {
          // grep returns exit code 1 when no matches found
          const execErr = err as { status?: number; stdout?: string };
          if (execErr.status === 1) return "(no matches)";
          throw err;
        }
      }

      default:
        return `Error: unknown tool "${toolName}"`;
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── System Prompt ─────────────────────────────────────────────────────

const AGENT_SYSTEM_PROMPT = `You are a coding agent with access to tools for reading, writing, editing files, running commands, and searching code. You work in a git worktree for a specific ticket.

CRITICAL REQUIREMENT — You MUST commit your work before finishing:
1. After completing all changes, run: git add -A
2. Then run: git commit -m "feat(TICKET-KEY): description of changes"
3. Verify with: git log --oneline -1
Your work is validated by checking git commits. No commit = FAILED regardless of files created.

Workflow:
1. Read the ticket requirements and existing files to understand context
2. Implement ONLY what the ticket asks for — do not scaffold unrelated files
3. Run tests if a test framework is configured (npm test)
4. git add -A && git commit with ticket ID (MANDATORY)
5. Summarize what you changed

Tools available:
- read_file: Read a file's contents
- write_file: Create or overwrite a file
- edit_file: Replace a specific string in a file (must be unique match)
- list_directory: List files in a directory
- run_command: Execute a shell command (60s timeout)
- search_files: Grep for a pattern across files`;

// ── Main Agent Loop ───────────────────────────────────────────────────

export async function runOpenRouterAgent(opts: {
  model: string;
  prompt: string;
  worktreePath: string;
  projectId: string;
  sessionId: string;
  agentId?: string;
  teamId?: string;
  ticketKey: string;
  abortSignal?: AbortSignal;
  maxTurns?: number;
}): Promise<OpenRouterAgentResult> {
  const maxTurns = opts.maxTurns ?? 50;
  const log: string[] = [];

  let totalCost = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalTokensAll = 0;

  const costContext: ChatCostContext = {
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    agentId: opts.agentId,
    teamId: opts.teamId,
    category: "agent_run_turn",
    ticketKey: opts.ticketKey,
  };

  const messages: ChatMessage[] = [
    { role: "system", content: AGENT_SYSTEM_PROMPT },
    { role: "user", content: opts.prompt },
  ];

  log.push(`[OpenRouter Agent] Starting with model: ${opts.model}`);
  log.push(`[OpenRouter Agent] Ticket: ${opts.ticketKey}`);
  log.push(`[OpenRouter Agent] Worktree: ${opts.worktreePath}`);
  log.push("");

  for (let turn = 0; turn < maxTurns; turn++) {
    // Check abort signal
    if (opts.abortSignal?.aborted) {
      log.push(`\n[OpenRouter Agent] Aborted at turn ${turn + 1}`);
      return {
        exitCode: 1,
        output: log.join("\n"),
        cost: totalCost,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalTokensAll,
      };
    }

    log.push(`--- Turn ${turn + 1}/${maxTurns} ---`);

    let response;
    try {
      response = await chat(messages, opts.model, costContext, {
        tools: AGENT_TOOLS,
        tool_choice: "auto",
      });
    } catch (err) {
      log.push(`[OpenRouter Agent] API error: ${err instanceof Error ? err.message : String(err)}`);
      return {
        exitCode: 1,
        output: log.join("\n"),
        cost: totalCost,
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalTokensAll,
      };
    }

    // Accumulate usage
    if (response.usage) {
      totalCost += response.usage.cost ?? 0;
      totalPromptTokens += response.usage.prompt_tokens;
      totalCompletionTokens += response.usage.completion_tokens;
      totalTokensAll += response.usage.total_tokens;
    }

    const choice = response.choices[0];
    if (!choice) {
      log.push("[OpenRouter Agent] No response choice — ending");
      break;
    }

    const assistantMessage = choice.message;

    // Add assistant message to conversation
    messages.push({
      role: "assistant",
      content: assistantMessage.content,
      tool_calls: assistantMessage.tool_calls,
    });

    // If there's text content, log it
    if (assistantMessage.content) {
      log.push(`[Assistant] ${assistantMessage.content}`);
    }

    // If no tool calls, the agent is done
    if (!assistantMessage.tool_calls || assistantMessage.tool_calls.length === 0) {
      log.push("\n[OpenRouter Agent] Agent finished (no more tool calls)");
      break;
    }

    // Execute each tool call
    for (const toolCall of assistantMessage.tool_calls) {
      const fnName = toolCall.function.name;
      let fnArgs: Record<string, unknown>;
      try {
        fnArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        fnArgs = {};
      }

      log.push(`[Tool: ${fnName}] Args: ${JSON.stringify(fnArgs).slice(0, 200)}`);

      const result = executeTool(fnName, fnArgs, opts.worktreePath);

      // Truncate result in logs but send full to model
      const logResult = result.length > 500 ? result.slice(0, 500) + "..." : result;
      log.push(`[Tool Result] ${logResult}`);

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: toolCall.id,
      });
    }
  }

  // Check if we hit the turn limit
  const lastMessage = messages[messages.length - 1];
  const hitLimit = lastMessage.role === "tool" || (lastMessage.role === "assistant" && lastMessage.tool_calls && lastMessage.tool_calls.length > 0);

  if (hitLimit) {
    log.push(`\n[OpenRouter Agent] Hit max turns (${maxTurns}) — stopping`);
  }

  // Commit-nudge: if agent left uncommitted work, give it 3 more turns to commit
  try {
    const statusResult = executeTool("run_command", { command: "git status --porcelain" }, opts.worktreePath);
    if (statusResult.trim() && statusResult !== "(no output)" && !statusResult.startsWith("Error")) {
      log.push("\n[OpenRouter Agent] Uncommitted changes detected — nudging to commit...");
      messages.push({
        role: "user",
        content: `You have uncommitted changes:\n${statusResult}\n\nYou MUST commit now:\n1. git add -A\n2. git commit -m "feat(${opts.ticketKey}): <your changes>"\nDo this immediately.`,
      });
      for (let nudge = 0; nudge < 3; nudge++) {
        if (opts.abortSignal?.aborted) break;
        let nudgeResp;
        try {
          nudgeResp = await chat(messages, opts.model, costContext, {
            tools: AGENT_TOOLS,
            tool_choice: "auto",
          });
        } catch {
          break;
        }
        if (nudgeResp.usage) {
          totalCost += nudgeResp.usage.cost ?? 0;
          totalPromptTokens += nudgeResp.usage.prompt_tokens;
          totalCompletionTokens += nudgeResp.usage.completion_tokens;
          totalTokensAll += nudgeResp.usage.total_tokens;
        }
        const nudgeChoice = nudgeResp.choices[0];
        if (!nudgeChoice) break;
        messages.push({
          role: "assistant",
          content: nudgeChoice.message.content,
          tool_calls: nudgeChoice.message.tool_calls,
        });
        if (nudgeChoice.message.content) {
          log.push(`[Assistant/Nudge] ${nudgeChoice.message.content}`);
        }
        if (!nudgeChoice.message.tool_calls || nudgeChoice.message.tool_calls.length === 0) break;
        for (const toolCall of nudgeChoice.message.tool_calls) {
          const fnName = toolCall.function.name;
          let fnArgs: Record<string, unknown>;
          try { fnArgs = JSON.parse(toolCall.function.arguments); } catch { fnArgs = {}; }
          log.push(`[Tool/Nudge: ${fnName}] Args: ${JSON.stringify(fnArgs).slice(0, 200)}`);
          const result = executeTool(fnName, fnArgs, opts.worktreePath);
          log.push(`[Tool Result/Nudge] ${result.length > 500 ? result.slice(0, 500) + "..." : result}`);
          messages.push({ role: "tool", content: result, tool_call_id: toolCall.id });
        }
      }
    }
  } catch { /* non-fatal */ }

  // Zero-work detection: if agent did nothing meaningful, mark as failed
  const toolCallCount = messages.filter((m) => m.role === "tool").length;
  if (toolCallCount === 0 || (totalCompletionTokens < 100 && toolCallCount < 2)) {
    log.push(`\n[OpenRouter Agent] Agent did no meaningful work (${toolCallCount} tool calls)`);
    return {
      exitCode: 1,
      output: log.join("\n"),
      cost: totalCost,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      totalTokens: totalTokensAll,
    };
  }

  log.push(`\n[OpenRouter Agent] Total cost: $${totalCost.toFixed(4)}`);
  log.push(`[OpenRouter Agent] Total tokens: ${totalTokensAll} (prompt: ${totalPromptTokens}, completion: ${totalCompletionTokens})`);

  return {
    exitCode: 0,
    output: log.join("\n"),
    cost: totalCost,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    totalTokens: totalTokensAll,
  };
}
