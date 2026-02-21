/**
 * Tavily web search client with cost tracking.
 * Used to enrich PRD/ARD generation and Lyra chat with real-time web context.
 */

import { prisma } from "./db";
import { trackUsage } from "./cost-tracker";

// ── Types ─────────────────────────────────────────────────────────────

export type TavilySearchResult = {
  title: string;
  url: string;
  content: string;
  score: number;
};

export type TavilyResponse = {
  query: string;
  answer?: string;
  results: TavilySearchResult[];
  searchDurationMs: number;
};

// ── API Key Helpers ───────────────────────────────────────────────────

export async function getTavilyApiKey(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "tavily_api_key" },
  });
  return setting?.value || process.env.TAVILY_API_KEY || "";
}

export async function isTavilyConfigured(): Promise<boolean> {
  const key = await getTavilyApiKey();
  return key.length > 0;
}

// ── Search ────────────────────────────────────────────────────────────

export async function searchWeb(
  query: string,
  options?: {
    maxResults?: number;
    searchDepth?: "basic" | "advanced";
    topic?: "general" | "news";
    includeAnswer?: boolean;
    projectId?: string;
    category?: string;
  }
): Promise<TavilyResponse> {
  const apiKey = await getTavilyApiKey();
  if (!apiKey) {
    throw new Error("Tavily API key not configured");
  }

  const maxResults = options?.maxResults ?? 5;
  const searchDepth = options?.searchDepth ?? "basic";
  const topic = options?.topic ?? "general";
  const includeAnswer = options?.includeAnswer ?? true;

  const startMs = Date.now();

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      search_depth: searchDepth,
      topic,
      include_answer: includeAnswer,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  const durationMs = Date.now() - startMs;

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Tavily API error ${response.status}: ${body.slice(0, 200)}`
    );
  }

  const data = await response.json();

  const results: TavilySearchResult[] = (data.results || []).map(
    (r: { title: string; url: string; content: string; score: number }) => ({
      title: r.title,
      url: r.url,
      content: r.content,
      score: r.score,
    })
  );

  // Estimate tokens from result content (chars / 4)
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0) +
    (data.answer?.length || 0);
  const estimatedTokens = Math.ceil(totalChars / 4);

  // Cost: ~$0.01 per basic search, ~$0.05 per advanced search
  const cost = searchDepth === "advanced" ? 0.05 : 0.01;

  // Track usage
  await trackUsage({
    projectId: options?.projectId,
    category: options?.category || "search",
    provider: "tavily",
    requestedModel: "tavily-search",
    actualModel: `tavily-search-${searchDepth}`,
    promptTokens: 0,
    completionTokens: estimatedTokens,
    totalTokens: estimatedTokens,
    cost,
    durationMs,
  });

  return {
    query,
    answer: data.answer || undefined,
    results,
    searchDurationMs: durationMs,
  };
}

// ── Prompt Formatting ─────────────────────────────────────────────────

export function formatSearchResultsForPrompt(results: TavilyResponse): string {
  const lines: string[] = [
    "## Web Research Context",
    `Query: "${results.query}"`,
  ];

  if (results.answer) {
    lines.push("", `Summary: ${results.answer}`);
  }

  lines.push("", "Sources:");

  for (let i = 0; i < results.results.length; i++) {
    const r = results.results[i];
    // Truncate excerpt to keep total output manageable
    const excerpt =
      r.content.length > 300 ? r.content.slice(0, 300) + "..." : r.content;
    lines.push(`${i + 1}. [${r.title}](${r.url}) — ${excerpt}`);
  }

  // Hard cap at ~3000 chars
  let output = lines.join("\n");
  if (output.length > 3000) {
    output = output.slice(0, 2997) + "...";
  }
  return output;
}
