/**
 * OpenRouter/auto client for non-coding AI tasks.
 * Preserves Claude Max budget by routing conversational tasks here.
 * Supports tool calling (OpenAI-compatible) for agent execution.
 */

import { prisma } from "@/lib/db";
import { trackUsage } from "./cost-tracker";

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

async function getApiKey(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "openrouter_api_key" },
  });
  if (setting?.value) return setting.value;
  return process.env.OPENROUTER_API_KEY || "";
}

// ── Tool Calling Types ────────────────────────────────────────────────

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

// ── Chat Types ────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatResponse {
  id: string;
  model: string;
  choices: {
    message: {
      role: string;
      content: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: number;
  };
}

export interface ChatCostContext {
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  teamId?: string;
  category?: string;
  ticketKey?: string;
}

export interface ChatOptions {
  tools?: ToolDefinition[];
  tool_choice?: "auto" | "none";
}

export async function chat(
  messages: ChatMessage[],
  model: string = "openrouter/auto",
  costContext?: ChatCostContext,
  options?: ChatOptions
): Promise<ChatResponse> {
  const apiKey = await getApiKey();
  if (!apiKey) {
    throw new Error(
      "OpenRouter API key not configured. Set it in Settings or via OPENROUTER_API_KEY env var."
    );
  }

  const startTime = Date.now();

  const body: Record<string, unknown> = { model, messages };
  if (options?.tools && options.tools.length > 0) {
    body.tools = options.tools;
    body.tool_choice = options.tool_choice ?? "auto";
  }

  const response = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://lyra.local",
      "X-Title": "Lyra Control",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${responseBody}`);
  }

  const result: ChatResponse = await response.json();

  // Track usage if we have cost context or usage data
  if (result.usage) {
    const durationMs = Date.now() - startTime;
    try {
      await trackUsage({
        projectId: costContext?.projectId,
        sessionId: costContext?.sessionId,
        agentId: costContext?.agentId,
        teamId: costContext?.teamId,
        category: costContext?.category || "general",
        ticketKey: costContext?.ticketKey,
        provider: "openrouter",
        requestedModel: model,
        actualModel: result.model || model,
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
        cost: result.usage.cost ?? 0,
        durationMs,
      });
    } catch (e) {
      console.error("[OpenRouter] Cost tracking failed (non-fatal):", e);
    }
  }

  return result;
}

export async function prompt(text: string, model?: string): Promise<string> {
  const response = await chat([{ role: "user", content: text }], model);
  return response.choices[0]?.message?.content || "";
}
