/**
 * Central cost tracking service — all LLM call sites use this to record usage.
 * Handles Claude Code stream-json output parsing, synthetic cost estimation,
 * and emitting cost:update events for real-time SSE updates.
 */

import { prisma } from "./db";
import { lyraEvents } from "./lyra-events";
import { CLOUD_MODELS } from "@/app/(dashboard)/onboarding/models";

// ── Types ─────────────────────────────────────────────────────────────

export interface TrackUsageParams {
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  teamId?: string;
  category: string;
  ticketKey?: string;
  provider: string;
  requestedModel: string;
  actualModel?: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  durationMs?: number;
  isLocal?: boolean;
}

export interface ParsedClaudeCodeCost {
  cost: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

// ── Model Pricing Map ─────────────────────────────────────────────────

const PRICING_MAP: Record<string, { inputPerMillion: number; outputPerMillion: number }> = {};

// Initialize from CLOUD_MODELS
for (const model of CLOUD_MODELS) {
  if (model.inputPerMillion != null && model.outputPerMillion != null) {
    PRICING_MAP[model.id] = {
      inputPerMillion: model.inputPerMillion,
      outputPerMillion: model.outputPerMillion,
    };
  }
}

// Add Claude Code models (used via Max subscription, but we track synthetic cost)
PRICING_MAP["claude-sonnet-4-5"] = { inputPerMillion: 3.0, outputPerMillion: 15.0 };
PRICING_MAP["claude-opus-4"] = { inputPerMillion: 5.0, outputPerMillion: 25.0 };
PRICING_MAP["claude-haiku-4-5"] = { inputPerMillion: 1.0, outputPerMillion: 5.0 };

export function getModelPricing(): Record<string, { inputPerMillion: number; outputPerMillion: number }> {
  return { ...PRICING_MAP };
}

// ── Synthetic Cost Estimation ─────────────────────────────────────────

/**
 * Estimate what a local model run would have cost on a comparable cloud model.
 * Uses claude-haiku-4-5 pricing as the baseline for local model equivalents.
 */
export function estimateCloudCost(
  promptTokens: number,
  completionTokens: number
): number {
  // Use Haiku pricing as the baseline for local model equivalents
  const pricing = PRICING_MAP["claude-haiku-4-5"] || { inputPerMillion: 1.0, outputPerMillion: 5.0 };
  return (
    (promptTokens / 1_000_000) * pricing.inputPerMillion +
    (completionTokens / 1_000_000) * pricing.outputPerMillion
  );
}

// ── Claude Code stream-json Output Parsing ────────────────────────────

/**
 * Parse Claude Code `--output-format stream-json` output to extract cost/token data.
 *
 * The stream-json format emits JSON lines. The final `result` message contains:
 * {
 *   "type": "result",
 *   "result": "...",
 *   "cost_usd": 0.123,
 *   "duration_ms": 45000,
 *   "duration_api_ms": 30000,
 *   "is_error": false,
 *   "num_turns": 5,
 *   "session_id": "...",
 *   "total_cost_usd": 0.456,
 *   "usage": {
 *     "input_tokens": 1000,
 *     "output_tokens": 500,
 *     "cache_creation_input_tokens": 0,
 *     "cache_read_input_tokens": 200
 *   }
 * }
 */
export function parseClaudeCodeOutput(output: string): ParsedClaudeCodeCost {
  const result: ParsedClaudeCodeCost = {
    cost: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };

  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed);

      if (parsed.type === "result") {
        // Use total_cost_usd if available, fallback to cost_usd
        result.cost = parsed.total_cost_usd ?? parsed.cost_usd ?? 0;

        if (parsed.usage) {
          result.promptTokens =
            (parsed.usage.input_tokens || 0) +
            (parsed.usage.cache_creation_input_tokens || 0) +
            (parsed.usage.cache_read_input_tokens || 0);
          result.completionTokens = parsed.usage.output_tokens || 0;
          result.totalTokens = result.promptTokens + result.completionTokens;
        }
      }
    } catch {
      // Not a JSON line — skip
    }
  }

  return result;
}

// ── Waste Metrics ─────────────────────────────────────────────────────

export interface WasteMetrics {
  totalSpend: number;
  wastedSpend: number;
  wasteRatio: number;
  firstAttemptSuccessRate: number;
  retrySuccessRate: number;
  infrastructureFailures: number;
  agentFailures: number;
  gateFailures: number;
  timeoutFailures: number;
}

/**
 * Calculate waste metrics across sessions.
 * "Wasted" spend = cost of sessions for tickets that required retries
 * (all attempts except the final successful one count as waste).
 */
export async function getWasteMetrics(projectId?: string): Promise<WasteMetrics> {
  const where = projectId ? { projectId } : {};

  // Get all sessions grouped by ticket
  const sessions = await prisma.session.findMany({
    where,
    select: {
      ticketKey: true,
      status: true,
      cost: true,
      failureCategory: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Group by ticket
  const byTicket = new Map<string, typeof sessions>();
  for (const s of sessions) {
    const list = byTicket.get(s.ticketKey) || [];
    list.push(s);
    byTicket.set(s.ticketKey, list);
  }

  let totalSpend = 0;
  let wastedSpend = 0;
  let firstAttemptSuccesses = 0;
  let retrySuccesses = 0;
  let totalTickets = 0;
  let infrastructureFailures = 0;
  let agentFailures = 0;
  let gateFailures = 0;
  let timeoutFailures = 0;

  for (const [, ticketSessions] of byTicket) {
    totalTickets++;
    let ticketTotal = 0;
    let hasSuccess = false;
    let successCost = 0;

    for (const s of ticketSessions) {
      ticketTotal += s.cost;

      if (s.status === "completed") {
        hasSuccess = true;
        successCost = s.cost;
      }

      if (s.status === "failed") {
        switch (s.failureCategory) {
          case "infrastructure": infrastructureFailures++; break;
          case "quality_gate": gateFailures++; break;
          case "timeout": timeoutFailures++; break;
          default: agentFailures++; break;
        }
      }
    }

    totalSpend += ticketTotal;

    if (hasSuccess) {
      // Waste = total cost minus the successful session's cost
      wastedSpend += ticketTotal - successCost;

      if (ticketSessions.length === 1) {
        firstAttemptSuccesses++;
      } else {
        retrySuccesses++;
      }
    } else {
      // No success yet — all spend is waste
      wastedSpend += ticketTotal;
    }
  }

  return {
    totalSpend,
    wastedSpend,
    wasteRatio: totalSpend > 0 ? wastedSpend / totalSpend : 0,
    firstAttemptSuccessRate: totalTickets > 0 ? firstAttemptSuccesses / totalTickets : 0,
    retrySuccessRate: totalTickets > 0 ? retrySuccesses / totalTickets : 0,
    infrastructureFailures,
    agentFailures,
    gateFailures,
    timeoutFailures,
  };
}

// ── Track Usage ───────────────────────────────────────────────────────

export async function trackUsage(params: TrackUsageParams): Promise<void> {
  const isLocal = params.isLocal ?? false;
  const syntheticCost = isLocal
    ? estimateCloudCost(params.promptTokens, params.completionTokens)
    : 0;

  const durationMs = params.durationMs ?? 0;
  const tokensPerSecond =
    durationMs > 0 ? (params.completionTokens / (durationMs / 1000)) : 0;

  await prisma.aiUsageLog.create({
    data: {
      projectId: params.projectId || null,
      sessionId: params.sessionId || null,
      agentId: params.agentId || null,
      teamId: params.teamId || null,
      document: params.category, // backward compat
      category: params.category,
      provider: params.provider,
      requestedModel: params.requestedModel,
      actualModel: params.actualModel || params.requestedModel,
      promptTokens: params.promptTokens,
      completionTokens: params.completionTokens,
      totalTokens: params.totalTokens,
      cost: params.cost,
      syntheticCost,
      isLocal,
      ticketKey: params.ticketKey || null,
      durationMs,
      tokensPerSecond,
    },
  });

  // Emit cost:update event for real-time SSE
  lyraEvents.emit("cost:update", {
    projectId: params.projectId,
    sessionId: params.sessionId,
    agentId: params.agentId,
    teamId: params.teamId,
    category: params.category,
    cost: params.cost,
    syntheticCost,
    model: params.actualModel || params.requestedModel,
    ticketKey: params.ticketKey,
    tokens: {
      prompt: params.promptTokens,
      completion: params.completionTokens,
      total: params.totalTokens,
    },
  });
}
