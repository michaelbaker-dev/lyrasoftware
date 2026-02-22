"use server";

import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth";

export async function getSetting(key: string): Promise<string | null> {
  const setting = await prisma.setting.findUnique({ where: { key } });
  return setting?.value ?? null;
}

export async function getSettings(
  keys: string[]
): Promise<Record<string, string | null>> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: keys } },
  });
  const result: Record<string, string | null> = {};
  for (const k of keys) {
    result[k] = settings.find((s) => s.key === k)?.value ?? null;
  }
  return result;
}

export async function getAllSettings(): Promise<Record<string, string>> {
  const settings = await prisma.setting.findMany();
  const result: Record<string, string> = {};
  for (const s of settings) {
    result[s.key] = s.value;
  }
  return result;
}

export async function saveSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}

export async function saveSettings(
  entries: Record<string, string>
): Promise<void> {
  const operations = Object.entries(entries).map(([key, value]) =>
    prisma.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    })
  );
  await prisma.$transaction(operations);
}

export async function deleteSetting(key: string): Promise<void> {
  await prisma.setting.deleteMany({ where: { key } });
}

// ── Model Selection Persistence ──────────────────────────────────────

export async function getLastModelSelection(key: string): Promise<string | null> {
  return getSetting(`model_last_${key}`);
}

export async function saveLastModelSelection(key: string, modelId: string): Promise<void> {
  await saveSetting(`model_last_${key}`, modelId);
}

// ── Connection test actions ──────────────────────────────────────────

export type TestResult = { ok: boolean; message: string };

export async function testJiraConnection(): Promise<TestResult> {
  try {
    const settings = await prisma.setting.findMany({
      where: { key: { in: ["jira_email", "jira_api_token", "jira_base_url"] } },
    });
    const email = settings.find((s) => s.key === "jira_email")?.value || process.env.JIRA_EMAIL || "";
    const token = settings.find((s) => s.key === "jira_api_token")?.value || process.env.JIRA_API_TOKEN || "";
    const baseUrl = settings.find((s) => s.key === "jira_base_url")?.value || "https://mbakers.atlassian.net";

    if (!email || !token) {
      return { ok: false, message: "Jira email and API token are required" };
    }

    const encoded = Buffer.from(`${email}:${token}`).toString("base64");
    const response = await fetch(`${baseUrl}/rest/api/3/myself`, {
      headers: {
        Authorization: `Basic ${encoded}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { ok: false, message: `Jira returned ${response.status}: ${response.statusText}` };
    }

    const data = await response.json();
    return { ok: true, message: `Connected as ${data.displayName}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function testGitHubConnection(): Promise<TestResult> {
  try {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const exec = promisify(execFile);

    const { stdout, stderr } = await exec("gh", ["auth", "status"], { timeout: 10000 });
    const output = stdout + stderr;
    const userMatch = output.match(/Logged in to .+ account (\S+)/) || output.match(/Logged in to .+ as (\S+)/);
    const user = userMatch?.[1] || "authenticated";
    return { ok: true, message: `Logged in as ${user}` };
  } catch (e) {
    const msg = (e as { stderr?: string; message: string }).stderr || (e as Error).message;
    return { ok: false, message: msg.trim() };
  }
}

export async function testOpenRouterConnection(): Promise<TestResult> {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "openrouter_api_key" },
    });
    const apiKey = setting?.value || process.env.OPENROUTER_API_KEY || "";

    if (!apiKey) {
      return { ok: false, message: "OpenRouter API key is not configured" };
    }

    // Use chat/completions with a minimal request to validate auth end-to-end
    // (the /models endpoint accepts invalid keys)
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://lyra.local",
        "X-Title": "Lyra Control",
      },
      body: JSON.stringify({
        model: "openrouter/auto",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      // Parse error message from OpenRouter JSON response
      let detail = `${response.status}: ${response.statusText}`;
      try {
        const parsed = JSON.parse(body);
        if (parsed.error?.message) detail = parsed.error.message;
      } catch { /* not JSON */ }
      return { ok: false, message: `OpenRouter: ${detail}` };
    }

    return { ok: true, message: "Connected (chat endpoint verified)" };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function testLmStudioConnection(): Promise<TestResult> {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "lm_studio_url" },
    });
    const url = setting?.value || "http://192.168.56.203:1234";

    const response = await fetch(`${url}/v1/models`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      return { ok: false, message: `LM Studio returned ${response.status}` };
    }

    const data = await response.json();
    const modelCount = data.data?.length || 0;
    return { ok: true, message: `Connected (${modelCount} model${modelCount !== 1 ? "s" : ""})` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function seedTavilyKeyFromEnv(): Promise<void> {
  const existing = await prisma.setting.findUnique({
    where: { key: "tavily_api_key" },
  });
  if (!existing?.value && process.env.TAVILY_API_KEY) {
    await prisma.setting.upsert({
      where: { key: "tavily_api_key" },
      update: { value: process.env.TAVILY_API_KEY },
      create: { key: "tavily_api_key", value: process.env.TAVILY_API_KEY },
    });
  }
}

export async function testTavilyConnection(): Promise<TestResult> {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "tavily_api_key" },
    });
    const apiKey = setting?.value || process.env.TAVILY_API_KEY || "";

    if (!apiKey) {
      return { ok: false, message: "Tavily API key is not configured" };
    }

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query: "test",
        max_results: 3,
        search_depth: "basic",
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, message: `Tavily returned ${response.status}: ${body.slice(0, 150)}` };
    }

    const data = await response.json();
    const resultCount = data.results?.length || 0;
    return { ok: true, message: `Connected (${resultCount} result${resultCount !== 1 ? "s" : ""})` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ── Channel test actions ────────────────────────────────────────────

export async function testIMessageChannel(): Promise<TestResult> {
  let normalizedRecipient = "";
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "imessage_recipient" },
    });
    let recipient = setting?.value;
    if (!recipient) {
      return { ok: false, message: "No recipient phone number configured" };
    }

    // Normalize phone number — ensure +country code
    const digits = recipient.replace(/\D/g, "");
    if (!recipient.startsWith("+")) {
      recipient = digits.length === 10 ? `+1${digits}` : `+${digits}`;
    }
    normalizedRecipient = recipient;

    const { spawn } = await import("child_process");

    // imsg v0.4+ uses --to/--text flags. It blocks waiting for delivery receipt,
    // so we spawn detached, wait briefly for errors, then report success.
    const result = await new Promise<TestResult>((resolve) => {
      const child = spawn("/opt/homebrew/bin/imsg", [
        "send", "--to", recipient, "--text",
        "Lyra test message — if you see this, iMessage is working.",
      ], { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      // If it errors quickly (bad args, invalid service), catch that
      child.on("error", (e) => {
        resolve({ ok: false, message: e.message });
      });

      child.on("close", (code) => {
        if (code !== 0 && stderr) {
          resolve({ ok: false, message: stderr.trim() });
        } else {
          resolve({ ok: true, message: `Test message sent to ${recipient}` });
        }
      });

      // If still running after 5s, the message was handed off to Messages.app — success
      setTimeout(() => {
        child.kill();
        resolve({ ok: true, message: `Test message sent to ${recipient}` });
      }, 5_000);
    });

    return result;
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function testEmailChannel(): Promise<TestResult> {
  try {
    const { sendEmail } = await import("@/lib/messaging/email");

    // Get configured recipient
    const toSetting = await prisma.setting.findUnique({ where: { key: "email_to" } });
    const to = toSetting?.value || "michael@baker.email";

    await sendEmail(
      to,
      "Lyra Channel Test — Email",
      "If you see this, the email channel is working correctly.\n\nSent from Lyra Control."
    );

    return { ok: true, message: `Test email sent to ${to}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function testTeamsChannel(): Promise<TestResult> {
  try {
    const keys = ["teams_app_id", "teams_app_password", "teams_tenant_id", "teams_conversation_ref"];
    const settings = await prisma.setting.findMany({
      where: { key: { in: keys } },
    });
    const config: Record<string, string> = {};
    for (const s of settings) config[s.key] = s.value;

    if (!config.teams_app_id || !config.teams_app_password) {
      return { ok: false, message: "Teams App ID and Password not configured" };
    }

    // Test auth token — use tenant-specific endpoint (app lives in tenant, not botframework.com)
    const tenant = config.teams_tenant_id || "botframework.com";
    const tokenResponse = await fetch(
      `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.teams_app_id,
          client_secret: config.teams_app_password,
          scope: "https://api.botframework.com/.default",
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!tokenResponse.ok) {
      const body = await tokenResponse.text().catch(() => "");
      return { ok: false, message: `Auth failed (${tokenResponse.status}): ${body.slice(0, 150)}` };
    }

    const tokenData = await tokenResponse.json();
    if (!tokenData.access_token) {
      return { ok: false, message: "No access token in response" };
    }

    // If conversation ref exists, send a test message
    if (config.teams_conversation_ref) {
      try {
        let ref: { serviceUrl: string; conversation: { id: string } };
        ref = JSON.parse(config.teams_conversation_ref);

        const msgResponse = await fetch(
          `${ref.serviceUrl}/v3/conversations/${ref.conversation.id}/activities`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              type: "message",
              text: "Lyra test message — if you see this, Teams is working.",
            }),
            signal: AbortSignal.timeout(10_000),
          }
        );

        if (msgResponse.ok) {
          return { ok: true, message: "Authenticated + test message sent" };
        }
        if (msgResponse.status === 404 || msgResponse.status === 403) {
          return {
            ok: false,
            message: `Conversation ref may be stale (${msgResponse.status}). Open Teams, message 'Lyra-ai-bot' directly, then re-import from OpenClaw.`,
          };
        }
        return { ok: true, message: `Authenticated (message send returned ${msgResponse.status})` };
      } catch {
        return {
          ok: false,
          message: "Conversation ref may be invalid. Open Teams, message 'Lyra-ai-bot' directly, then re-import from OpenClaw.",
        };
      }
    }

    return { ok: true, message: "Authenticated (no conversation ref — configure to enable messaging)" };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function testSlackConnection(): Promise<TestResult> {
  try {
    const { testSlackConnection: testSlack } = await import("@/lib/messaging/slack");
    return testSlack();
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export async function testWebhookChannel(): Promise<TestResult> {
  try {
    const setting = await prisma.setting.findUnique({
      where: { key: "webhook_url" },
    });
    const url = setting?.value;
    if (!url) {
      return { ok: false, message: "No webhook URL configured" };
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "Lyra test message — if you see this, the webhook is working.",
        content: "Lyra test message — if you see this, the webhook is working.",
        title: "Lyra Channel Test",
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return { ok: false, message: `Webhook returned ${response.status}: ${body.slice(0, 200)}` };
    }

    return { ok: true, message: "Message posted successfully" };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ── Seed channel defaults from OpenClaw ─────────────────────────────

export async function seedChannelDefaults(): Promise<TestResult> {
  try {
    const { existsSync, readFileSync } = await import("fs");
    const { join } = await import("path");

    const openclawDir = join(process.env.HOME || "", ".openclaw");
    if (!existsSync(openclawDir)) {
      return { ok: false, message: "OpenClaw not found at ~/.openclaw" };
    }

    const seeded: string[] = [];

    // Read openclaw.json for Teams/Azure credentials
    const configPath = join(openclawDir, "openclaw.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));

      // Teams / Azure app registration
      const teams = config.channels?.msteams;
      if (teams) {
        const defaults: Record<string, string> = {
          teams_app_id: teams.appId || "",
          teams_app_password: teams.appPassword || "",
          teams_tenant_id: teams.tenantId || "",
          teams_enabled: "true",
        };
        for (const [key, value] of Object.entries(defaults)) {
          if (value) {
            await prisma.setting.upsert({
              where: { key },
              update: { value },
              create: { key, value },
            });
          }
        }
        seeded.push("Teams credentials");
      }

      // iMessage config
      const imsg = config.channels?.imessage;
      if (imsg?.enabled) {
        await prisma.setting.upsert({
          where: { key: "imessage_enabled" },
          update: { value: "true" },
          create: { key: "imessage_enabled", value: "true" },
        });
        seeded.push("iMessage enabled");
      }
    }

    // Read iMessage allowed-from for recipient phone numbers
    const imsgAllowPath = join(openclawDir, "credentials", "imessage-allowFrom.json");
    if (existsSync(imsgAllowPath)) {
      const allowList = JSON.parse(readFileSync(imsgAllowPath, "utf-8"));
      const phones = Object.keys(allowList).filter((k) => k.startsWith("+"));
      if (phones.length > 0) {
        // Use the first phone number as the default recipient
        await prisma.setting.upsert({
          where: { key: "imessage_recipient" },
          update: { value: phones[0] },
          create: { key: "imessage_recipient", value: phones[0] },
        });
        seeded.push(`iMessage recipient: ${phones[0]}`);
      }
    }

    // Read Teams conversation reference
    const teamsConvPath = join(openclawDir, "msteams-conversations.json");
    if (existsSync(teamsConvPath)) {
      const convData = JSON.parse(readFileSync(teamsConvPath, "utf-8"));
      const conversations = convData.conversations || {};
      const convIds = Object.keys(conversations);
      if (convIds.length > 0) {
        const conv = conversations[convIds[0]];
        const ref = JSON.stringify({
          serviceUrl: conv.serviceUrl,
          conversation: conv.conversation,
        });
        await prisma.setting.upsert({
          where: { key: "teams_conversation_ref" },
          update: { value: ref },
          create: { key: "teams_conversation_ref", value: ref },
        });
        seeded.push(`Teams conversation (${conv.user?.name || "unknown"})`);
      }
    }

    // Read OpenRouter API key from agent auth profiles
    const orAuthPath = join(openclawDir, "agents", "main", "agent", "auth-profiles.json");
    if (existsSync(orAuthPath)) {
      const authProfiles = JSON.parse(readFileSync(orAuthPath, "utf-8"));
      const orProfile = authProfiles.profiles?.find?.(
        (p: { provider: string }) => p.provider === "openrouter"
      );
      if (orProfile?.token) {
        // Only seed if not already set
        const existing = await prisma.setting.findUnique({ where: { key: "openrouter_api_key" } });
        if (!existing?.value) {
          await prisma.setting.upsert({
            where: { key: "openrouter_api_key" },
            update: { value: orProfile.token },
            create: { key: "openrouter_api_key", value: orProfile.token },
          });
          seeded.push("OpenRouter API key");
        }
      }
    }

    // Set email defaults
    await prisma.setting.upsert({
      where: { key: "email_from" },
      update: {},  // don't overwrite if exists
      create: { key: "email_from", value: "lyra@baker.email" },
    });
    await prisma.setting.upsert({
      where: { key: "email_to" },
      update: {},
      create: { key: "email_to", value: "michael@baker.email" },
    });
    seeded.push("Email defaults (lyra@baker.email)");

    if (seeded.length === 0) {
      return { ok: false, message: "No importable data found in OpenClaw" };
    }

    return { ok: true, message: `Imported: ${seeded.join(", ")}` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

// ── Model Catalog ───────────────────────────────────────────────────

export interface CatalogModel {
  id: string;
  name: string;
  provider: string;
  source: "claude-code" | "openrouter" | "local";
  promptCostPerM: number | null;
  completionCostPerM: number | null;
  contextLength: number;
  codingScore: number;
  codingRank: "excellent" | "strong" | "good" | "basic";
  description: string;
}

interface ModelCatalogCache {
  fetchedAt: string;
  models: CatalogModel[];
}

const STATIC_CLAUDE_CODE_MODELS: CatalogModel[] = [
  {
    id: "claude-code/opus-4.6",
    name: "Claude Opus 4.6 (CLI)",
    provider: "anthropic",
    source: "claude-code",
    promptCostPerM: null,
    completionCostPerM: null,
    contextLength: 200000,
    codingScore: 98,
    codingRank: "excellent",
    description: "Best reasoning via Claude Code. Uses Max subscription.",
  },
  {
    id: "claude-code/sonnet-4.6",
    name: "Claude Sonnet 4.6 (CLI)",
    provider: "anthropic",
    source: "claude-code",
    promptCostPerM: null,
    completionCostPerM: null,
    contextLength: 200000,
    codingScore: 92,
    codingRank: "excellent",
    description: "Balanced quality for dev work via Claude Code. Uses Max subscription.",
  },
  {
    id: "claude-code/haiku-4.5",
    name: "Claude Haiku 4.5 (CLI)",
    provider: "anthropic",
    source: "claude-code",
    promptCostPerM: null,
    completionCostPerM: null,
    contextLength: 200000,
    codingScore: 75,
    codingRank: "strong",
    description: "Fast, good for simple tasks via Claude Code. Uses Max subscription.",
  },
  {
    id: "claude-code/opus",
    name: "Claude Opus Latest (CLI)",
    provider: "anthropic",
    source: "claude-code",
    promptCostPerM: null,
    completionCostPerM: null,
    contextLength: 200000,
    codingScore: 98,
    codingRank: "excellent",
    description: "Best reasoning via Claude Code (latest version). Uses Max subscription.",
  },
  {
    id: "claude-code/sonnet",
    name: "Claude Sonnet Latest (CLI)",
    provider: "anthropic",
    source: "claude-code",
    promptCostPerM: null,
    completionCostPerM: null,
    contextLength: 200000,
    codingScore: 92,
    codingRank: "excellent",
    description: "Balanced quality for dev work via Claude Code (latest version). Uses Max subscription.",
  },
  {
    id: "claude-code/haiku",
    name: "Claude Haiku Latest (CLI)",
    provider: "anthropic",
    source: "claude-code",
    promptCostPerM: null,
    completionCostPerM: null,
    contextLength: 200000,
    codingScore: 75,
    codingRank: "strong",
    description: "Fast, good for simple tasks via Claude Code (latest version). Uses Max subscription.",
  },
];

const OPENROUTER_AUTO_MODEL: CatalogModel = {
  id: "openrouter/auto",
  name: "OpenRouter / auto",
  provider: "openrouter",
  source: "openrouter",
  promptCostPerM: null,
  completionCostPerM: null,
  contextLength: 200000,
  codingScore: 80,
  codingRank: "strong",
  description: "OpenRouter picks the best model for the task. Cost varies.",
};

function scoreToRank(score: number): CatalogModel["codingRank"] {
  if (score >= 90) return "excellent";
  if (score >= 70) return "strong";
  if (score >= 50) return "good";
  return "basic";
}

// Curated best-in-class coding models with hardcoded scores (no LLM ranking needed)
const CURATED_MODELS: {
  id: string;
  name: string;
  score: number;
  promptCost: number;
  completionCost: number;
  contextLength: number;
  tier: "premium" | "standard" | "low-cost";
}[] = [
  // Premium (score 90+)
  { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", score: 95, promptCost: 5, completionCost: 25, contextLength: 200000, tier: "premium" },
  { id: "openai/o3", name: "o3", score: 93, promptCost: 2, completionCost: 8, contextLength: 200000, tier: "premium" },
  { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro", score: 92, promptCost: 1.25, completionCost: 10, contextLength: 1000000, tier: "premium" },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", score: 90, promptCost: 3, completionCost: 15, contextLength: 200000, tier: "premium" },
  // Standard (score 70-89)
  { id: "openai/gpt-4.1", name: "GPT-4.1", score: 85, promptCost: 2, completionCost: 8, contextLength: 1000000, tier: "standard" },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", score: 82, promptCost: 0.30, completionCost: 2.50, contextLength: 1000000, tier: "standard" },
  { id: "anthropic/claude-haiku-4.5", name: "Claude Haiku 4.5", score: 78, promptCost: 1, completionCost: 5, contextLength: 200000, tier: "standard" },
  { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", score: 76, promptCost: 0.19, completionCost: 0.87, contextLength: 128000, tier: "standard" },
  { id: "x-ai/grok-3-mini", name: "Grok 3 Mini", score: 72, promptCost: 0.30, completionCost: 0.50, contextLength: 131000, tier: "standard" },
  // Low-Cost (score 50-69)
  { id: "meta-llama/llama-4-maverick", name: "Llama 4 Maverick", score: 62, promptCost: 0.15, completionCost: 0.60, contextLength: 1000000, tier: "low-cost" },
  { id: "qwen/qwen3-coder-480b", name: "Qwen3 Coder 480B", score: 60, promptCost: 0.50, completionCost: 0.50, contextLength: 256000, tier: "low-cost" },
  { id: "mistralai/codestral-2501", name: "Codestral", score: 58, promptCost: 0.30, completionCost: 0.90, contextLength: 256000, tier: "low-cost" },
  { id: "google/gemma-3-27b-it", name: "Gemma 3 27B", score: 52, promptCost: 0.10, completionCost: 0.20, contextLength: 96000, tier: "low-cost" },
];

const CURATED_IDS = new Set(CURATED_MODELS.map((m) => m.id));

export async function getModelCatalog(): Promise<CatalogModel[]> {
  const cached = await prisma.setting.findUnique({
    where: { key: "model_catalog_cache" },
  });
  if (cached?.value) {
    try {
      const data: ModelCatalogCache = JSON.parse(cached.value);
      if (data.models?.length > 0) return data.models;
    } catch { /* invalid cache, return fallback */ }
  }
  // Fallback: static entries
  return [...STATIC_CLAUDE_CODE_MODELS, OPENROUTER_AUTO_MODEL];
}

export async function getModelCatalogMeta(): Promise<{ fetchedAt: string | null; modelCount: number }> {
  const cached = await prisma.setting.findUnique({
    where: { key: "model_catalog_cache" },
  });
  if (cached?.value) {
    try {
      const data: ModelCatalogCache = JSON.parse(cached.value);
      return { fetchedAt: data.fetchedAt, modelCount: data.models?.length ?? 0 };
    } catch { /* fall through */ }
  }
  return { fetchedAt: null, modelCount: 0 };
}

export async function refreshModelCatalog(): Promise<{
  success: boolean;
  modelCount: number;
  error?: string;
}> {
  try {
    const apiKeySetting = await prisma.setting.findUnique({
      where: { key: "openrouter_api_key" },
    });
    const apiKey = apiKeySetting?.value || process.env.OPENROUTER_API_KEY || "";

    // 1. Fetch OpenRouter models for live pricing on curated IDs only
    const livePricing = new Map<string, { prompt: number; completion: number; contextLength: number }>();
    if (apiKey) {
      try {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const data = await res.json();
          for (const m of (data.data || []) as Array<{
            id: string;
            pricing?: { prompt?: string; completion?: string };
            context_length?: number;
          }>) {
            if (CURATED_IDS.has(m.id)) {
              livePricing.set(m.id, {
                prompt: m.pricing?.prompt ? parseFloat(m.pricing.prompt) * 1_000_000 : 0,
                completion: m.pricing?.completion ? parseFloat(m.pricing.completion) * 1_000_000 : 0,
                contextLength: m.context_length || 0,
              });
            }
          }
        }
      } catch { /* OpenRouter unavailable — use hardcoded prices */ }
    }

    // 2. Build curated OpenRouter models (with live pricing where available)
    const openrouterModels: CatalogModel[] = CURATED_MODELS.map((cm) => {
      const live = livePricing.get(cm.id);
      return {
        id: cm.id,
        name: cm.name,
        provider: cm.id.split("/")[0],
        source: "openrouter" as const,
        promptCostPerM: live?.prompt ?? cm.promptCost,
        completionCostPerM: live?.completion ?? cm.completionCost,
        contextLength: live?.contextLength ?? cm.contextLength,
        codingScore: cm.score,
        codingRank: scoreToRank(cm.score),
        description: "",
      };
    });

    // 3. Fetch LM Studio models (dynamic — these change)
    let localModels: CatalogModel[] = [];
    try {
      const lmUrlSetting = await prisma.setting.findUnique({
        where: { key: "lm_studio_url" },
      });
      const lmUrl = lmUrlSetting?.value || "http://192.168.56.203:1234";
      const lmRes = await fetch(`${lmUrl}/v1/models`, {
        signal: AbortSignal.timeout(5000),
      });
      if (lmRes.ok) {
        const { matchLocalModel } = await import("@/app/(dashboard)/onboarding/models");
        const lmData = await lmRes.json();
        localModels = ((lmData.data || []) as Array<{ id: string }>)
          .map((m) => m.id)
          .filter((id) => !id.includes("embedding") && !id.includes("nomic"))
          .map((id) => {
            const info = matchLocalModel(id);
            const capToScore = { excellent: 92, strong: 78, good: 60, basic: 35 };
            const score = capToScore[info.capability] ?? 50;
            return {
              id: info.id,
              name: info.label,
              provider: "local",
              source: "local" as const,
              promptCostPerM: 0,
              completionCostPerM: 0,
              contextLength: 32000,
              codingScore: score,
              codingRank: scoreToRank(score),
              description: `${info.parameterSize} — ${info.description}`,
            };
          });
      }
    } catch { /* LM Studio not available, skip */ }

    // 4. Combine all models (no LLM ranking — scores are hardcoded)
    const allModels = [
      ...STATIC_CLAUDE_CODE_MODELS,
      OPENROUTER_AUTO_MODEL,
      ...openrouterModels,
      ...localModels.sort((a, b) => b.codingScore - a.codingScore),
    ];

    // 5. Save to cache
    const cache: ModelCatalogCache = {
      fetchedAt: new Date().toISOString(),
      models: allModels,
    };
    await prisma.setting.upsert({
      where: { key: "model_catalog_cache" },
      update: { value: JSON.stringify(cache) },
      create: { key: "model_catalog_cache", value: JSON.stringify(cache) },
    });

    return { success: true, modelCount: allModels.length };
  } catch (e) {
    return { success: false, modelCount: 0, error: (e as Error).message };
  }
}

// ── Role Config CRUD ─────────────────────────────────────────────────

export async function getRoles() {
  const { getAllRoles } = await import("@/lib/role-config");
  return getAllRoles();
}

export async function createRole(data: {
  role: string;
  label: string;
  phase: number;
  prompt: string;
  color: string;
}): Promise<{ success: boolean; error?: string }> {
  try {
    const { invalidateRoleCache } = await import("@/lib/role-config");
    await prisma.roleConfig.create({
      data: {
        role: data.role,
        label: data.label,
        phase: data.phase,
        prompt: data.prompt || null,
        color: data.color,
        isBuiltIn: false,
      },
    });
    invalidateRoleCache();
    return { success: true };
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("Unique constraint")) {
      return { success: false, error: `Role "${data.role}" already exists` };
    }
    return { success: false, error: msg };
  }
}

export async function updateRole(
  id: string,
  data: { label?: string; phase?: number; prompt?: string | null; color?: string }
): Promise<{ success: boolean; error?: string }> {
  try {
    const { invalidateRoleCache } = await import("@/lib/role-config");
    await prisma.roleConfig.update({ where: { id }, data });
    invalidateRoleCache();
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function deleteRole(id: string): Promise<{ success: boolean; error?: string }> {
  try {
    const { invalidateRoleCache } = await import("@/lib/role-config");
    const role = await prisma.roleConfig.findUnique({ where: { id } });
    if (!role) return { success: false, error: "Role not found" };
    if (role.isBuiltIn) return { success: false, error: "Cannot delete built-in roles" };

    await prisma.roleConfig.delete({ where: { id } });
    invalidateRoleCache();
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

// ── User management ───────────────────────────────────────────────────

export type UserInfo = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  lastLoginAt: string | null;
  createdAt: string;
};

export async function getUsers(): Promise<UserInfo[]> {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      lastLoginAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  return users.map((u) => ({
    ...u,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
  }));
}

export async function createUser(
  email: string,
  password: string,
  name?: string
): Promise<TestResult> {
  try {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return { success: false, error: "Invalid email format" };
    }
    if (password.length < 12) {
      return { success: false, error: "Password must be at least 12 characters" };
    }
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return { success: false, error: "Email already taken" };
    }
    const passwordHash = await hashPassword(password);
    await prisma.user.create({
      data: { email, passwordHash, name: name || null },
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function deleteUser(id: string): Promise<TestResult> {
  try {
    const count = await prisma.user.count();
    if (count <= 1) {
      return { success: false, error: "Cannot delete the last user" };
    }
    await prisma.user.delete({ where: { id } });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function resetUserPassword(
  id: string,
  newPassword: string
): Promise<TestResult> {
  try {
    if (newPassword.length < 12) {
      return { success: false, error: "Password must be at least 12 characters" };
    }
    const passwordHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id },
      data: { passwordHash, failedAttempts: 0, lockedUntil: null },
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
