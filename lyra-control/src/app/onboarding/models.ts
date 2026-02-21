// ── Cloud Models (OpenRouter) ────────────────────────────────────────

export type CloudModelInfo = {
  id: string;
  label: string;
  source: "cloud";
  inputPerMillion: number | null;
  outputPerMillion: number | null;
  tier: "premium" | "standard" | "budget" | "auto";
  description: string;
};

export const CLOUD_MODELS: CloudModelInfo[] = [
  {
    id: "openrouter/auto",
    label: "Auto (best match)",
    source: "cloud",
    inputPerMillion: null,
    outputPerMillion: null,
    tier: "auto",
    description: "OpenRouter picks the best model for the task",
  },
  {
    id: "claude-code/opus",
    label: "Claude Code Opus",
    source: "cloud",
    inputPerMillion: null,
    outputPerMillion: null,
    tier: "premium",
    description: "Best reasoning, ideal for architecture. Uses Max subscription.",
  },
  {
    id: "claude-code/sonnet",
    label: "Claude Code Sonnet",
    source: "cloud",
    inputPerMillion: null,
    outputPerMillion: null,
    tier: "standard",
    description: "Balanced quality for dev work. Uses Max subscription.",
  },
  {
    id: "claude-code/haiku",
    label: "Claude Code Haiku",
    source: "cloud",
    inputPerMillion: null,
    outputPerMillion: null,
    tier: "budget",
    description: "Fast, good for simple tasks. Uses Max subscription.",
  },
  {
    id: "anthropic/claude-opus-4.6",
    label: "Claude Opus 4.6",
    source: "cloud",
    inputPerMillion: 5.0,
    outputPerMillion: 25.0,
    tier: "premium",
    description: "Strong reasoning, 1M context, great for PRD/ARD",
  },
  {
    id: "anthropic/claude-sonnet-4.5",
    label: "Claude Sonnet 4.5",
    source: "cloud",
    inputPerMillion: 3.0,
    outputPerMillion: 15.0,
    tier: "standard",
    description: "Good balance of quality and cost for technical docs",
  },
  {
    id: "google/gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    source: "cloud",
    inputPerMillion: 1.25,
    outputPerMillion: 10.0,
    tier: "standard",
    description: "Strong reasoning at moderate cost, 1M context",
  },
  {
    id: "anthropic/claude-haiku-4.5",
    label: "Claude Haiku 4.5",
    source: "cloud",
    inputPerMillion: 1.0,
    outputPerMillion: 5.0,
    tier: "budget",
    description: "Fast and cheap, good for simple projects",
  },
  {
    id: "google/gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    source: "cloud",
    inputPerMillion: 0.3,
    outputPerMillion: 2.5,
    tier: "budget",
    description: "Very cheap, fast drafts and iteration",
  },
  {
    id: "deepseek/deepseek-chat-v3-0324",
    label: "DeepSeek V3",
    source: "cloud",
    inputPerMillion: 0.19,
    outputPerMillion: 0.87,
    tier: "budget",
    description: "Extremely cheap, good quality for the price",
  },
  {
    id: "meta-llama/llama-4-maverick",
    label: "Llama 4 Maverick",
    source: "cloud",
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
    tier: "budget",
    description: "Cheapest option, open-weight, variable quality",
  },
];

// ── Local Models (LM Studio) ────────────────────────────────────────

export type LocalModelInfo = {
  id: string;
  label: string;
  source: "local";
  parameterSize: string;
  capability: "excellent" | "strong" | "good" | "basic";
  description: string;
};

export type ModelInfo = CloudModelInfo | LocalModelInfo;

// Known local model metadata — matched by substring against LM Studio model IDs
export const LOCAL_MODEL_CATALOG: Record<
  string,
  { label: string; parameterSize: string; capability: LocalModelInfo["capability"]; description: string }
> = {
  "qwen3-coder-480b": {
    label: "Qwen3 Coder 480B",
    parameterSize: "480B MoE (35B active)",
    capability: "excellent",
    description: "Massive coding MoE, excellent for technical architecture",
  },
  "qwen/qwen3-coder-480b": {
    label: "Qwen3 Coder 480B",
    parameterSize: "480B MoE (35B active)",
    capability: "excellent",
    description: "Massive coding MoE, excellent for technical architecture",
  },
  "kimi-k2-thinking": {
    label: "Kimi K2 Thinking",
    parameterSize: "1T MoE (32B active)",
    capability: "excellent",
    description: "Chain-of-thought reasoning, great for complex PRD/ARD",
  },
  "gpt-oss-120b": {
    label: "GPT-OSS 120B",
    parameterSize: "120B",
    capability: "excellent",
    description: "Large dense model, strong general reasoning",
  },
  "deepseek-v3-0324": {
    label: "DeepSeek V3",
    parameterSize: "671B MoE (37B active)",
    capability: "excellent",
    description: "Excellent quality, strong at technical writing",
  },
  "kimi-dev-72b": {
    label: "Kimi Dev 72B",
    parameterSize: "72B",
    capability: "strong",
    description: "Development-focused, good for architecture docs",
  },
  "minimax-m2.5": {
    label: "MiniMax M2.5",
    parameterSize: "456B MoE",
    capability: "strong",
    description: "Modern MoE model, good reasoning capability",
  },
  "minimax-m2": {
    label: "MiniMax M2",
    parameterSize: "456B MoE",
    capability: "strong",
    description: "Predecessor to M2.5, solid reasoning",
  },
  "qwen3-42b": {
    label: "Qwen3 42B MoE",
    parameterSize: "42B MoE (3B active)",
    capability: "good",
    description: "Efficient MoE, decent quality for drafts",
  },
  "gpt-oss-20b": {
    label: "GPT-OSS 20B",
    parameterSize: "20B",
    capability: "good",
    description: "Compact but capable, good for iteration",
  },
  "deepseek-r1-distill-qwen-32b": {
    label: "DeepSeek R1 Distill 32B",
    parameterSize: "32B",
    capability: "good",
    description: "Reasoning-focused distillation, solid for structured docs",
  },
  "gemma-3-27b-it": {
    label: "Gemma 3 27B",
    parameterSize: "27B",
    capability: "good",
    description: "Google's compact model, good instruction following",
  },
  "meta-llama-3.1-8b": {
    label: "Llama 3.1 8B",
    parameterSize: "8B",
    capability: "basic",
    description: "Small model, fast but limited quality",
  },
  "llama-3.2-3b": {
    label: "Llama 3.2 3B",
    parameterSize: "3B",
    capability: "basic",
    description: "Very small, only for quick rough drafts",
  },
  "kimi-vl-a3b": {
    label: "Kimi VL A3B",
    parameterSize: "3B (vision)",
    capability: "basic",
    description: "Vision model, not ideal for text generation",
  },
};

// Match an LM Studio model ID to our catalog by substring
export function matchLocalModel(modelId: string): LocalModelInfo {
  for (const [key, meta] of Object.entries(LOCAL_MODEL_CATALOG)) {
    if (modelId.includes(key) || modelId.toLowerCase().includes(key.toLowerCase())) {
      return {
        id: `local:${modelId}`,
        label: meta.label,
        source: "local",
        parameterSize: meta.parameterSize,
        capability: meta.capability,
        description: meta.description,
      };
    }
  }
  // Unknown model — show as-is
  return {
    id: `local:${modelId}`,
    label: modelId,
    source: "local",
    parameterSize: "Unknown",
    capability: "good",
    description: "Model not in catalog — capabilities unknown",
  };
}

// Kept for backward compat — cloud models only
export const MODEL_CATALOG = CLOUD_MODELS;
