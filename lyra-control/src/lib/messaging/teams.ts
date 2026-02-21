/**
 * MS Teams channel — sends proactive messages via Bot Framework.
 * Requires Azure Bot registration (appId: 5c384f3c-...).
 * Uses direct REST API calls to Bot Framework.
 */

import { prisma } from "../db";

interface TeamsConfig {
  appId: string;
  appPassword: string;
  tenantId: string;
}

async function getTeamsConfig(): Promise<TeamsConfig | null> {
  const keys = ["teams_app_id", "teams_app_password", "teams_tenant_id"];
  const settings = await prisma.setting.findMany({
    where: { key: { in: keys } },
  });

  const config: Record<string, string> = {};
  for (const s of settings) {
    config[s.key] = s.value;
  }

  if (!config.teams_app_id || !config.teams_app_password) {
    return null;
  }

  return {
    appId: config.teams_app_id,
    appPassword: config.teams_app_password,
    tenantId: config.teams_tenant_id || "",
  };
}

async function getBotToken(config: TeamsConfig): Promise<string> {
  // Use tenant-specific endpoint (not botframework.com) — the app registration
  // lives in the tenant directory, not the Bot Framework directory.
  const tenant = config.tenantId || "botframework.com";
  const response = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.appId,
        client_secret: config.appPassword,
        scope: "https://api.botframework.com/.default",
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Teams auth failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return data.access_token;
}

export async function sendTeamsMessage(
  conversationRef: string,
  message: string
): Promise<void> {
  const config = await getTeamsConfig();
  if (!config) {
    throw new Error("Teams not configured. Set teams_app_id, teams_app_password in Settings.");
  }

  // Parse conversation reference (stored as JSON)
  let ref: { serviceUrl: string; conversation: { id: string } };
  try {
    ref = JSON.parse(conversationRef);
  } catch {
    throw new Error("Invalid Teams conversation reference");
  }

  const token = await getBotToken(config);

  const response = await fetch(
    `${ref.serviceUrl}/v3/conversations/${ref.conversation.id}/activities`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "message",
        text: message,
      }),
    }
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Teams send failed (${response.status}): ${text}`);
  }
}
