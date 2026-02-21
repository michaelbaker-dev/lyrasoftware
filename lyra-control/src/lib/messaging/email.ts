/**
 * Email channel — sends email via Microsoft Graph API (primary) or SMTP (fallback).
 * Graph API uses the same Azure app registration as Teams (shared clientId/secret).
 * Sends as lyra@baker.email.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { prisma } from "../db";

const exec = promisify(execFile);

// ── Microsoft Graph API (primary) ───────────────────────────────────

interface GraphConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  from: string;
}

async function getGraphConfig(): Promise<GraphConfig | null> {
  const keys = [
    "teams_app_id",       // shared Azure app registration
    "teams_app_password",
    "teams_tenant_id",
    "email_from",
  ];
  const settings = await prisma.setting.findMany({
    where: { key: { in: keys } },
  });

  const config: Record<string, string> = {};
  for (const s of settings) {
    config[s.key] = s.value;
  }

  if (!config.teams_app_id || !config.teams_app_password || !config.teams_tenant_id) {
    return null;
  }

  return {
    clientId: config.teams_app_id,
    clientSecret: config.teams_app_password,
    tenantId: config.teams_tenant_id,
    from: config.email_from || "lyra@baker.email",
  };
}

async function getGraphToken(config: GraphConfig): Promise<string> {
  const response = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: config.clientId,
        client_secret: config.clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Graph auth failed (${response.status}): ${body}`);
  }

  const data = await response.json();
  return data.access_token;
}

// Generate a stable message-id for per-project email threading
function generateThreadHeaders(subject: string): {
  internetMessageId?: string;
  references?: string;
} {
  // Extract [JIRA_KEY] from subject for threading
  const keyMatch = subject.match(/^\[([A-Z][\w-]*)\]/);
  if (!keyMatch) return {};

  const jiraKey = keyMatch[1].toLowerCase();
  const messageId = `<lyra-${jiraKey}@baker.email>`;

  return {
    internetMessageId: messageId,
    references: messageId,
  };
}

async function sendViaGraph(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const config = await getGraphConfig();
  if (!config) {
    throw new Error("Graph API not configured (needs Teams app credentials + tenant)");
  }

  const token = await getGraphToken(config);

  const threadHeaders = generateThreadHeaders(subject);

  // Build internet message headers for threading
  const internetMessageHeaders: { name: string; value: string }[] = [];
  if (threadHeaders.references) {
    internetMessageHeaders.push(
      { name: "References", value: threadHeaders.references },
      { name: "In-Reply-To", value: threadHeaders.references }
    );
  }

  const messagePayload: Record<string, unknown> = {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: [{ emailAddress: { address: to } }],
  };

  if (internetMessageHeaders.length > 0) {
    messagePayload.internetMessageHeaders = internetMessageHeaders;
  }

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${config.from}/sendMail`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: messagePayload,
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Graph sendMail failed (${response.status}): ${errorBody}`);
  }
}

// ── SMTP fallback ───────────────────────────────────────────────────

interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const keys = ["smtp_host", "smtp_port", "smtp_user", "smtp_password", "email_from"];
  const settings = await prisma.setting.findMany({
    where: { key: { in: keys } },
  });

  const config: Record<string, string> = {};
  for (const s of settings) {
    config[s.key] = s.value;
  }

  if (!config.smtp_host || !config.smtp_user || !config.smtp_password) {
    return null;
  }

  return {
    host: config.smtp_host,
    port: parseInt(config.smtp_port || "587", 10),
    user: config.smtp_user,
    password: config.smtp_password,
    from: config.email_from || "lyra@baker.email",
  };
}

async function sendViaSmtp(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  const config = await getSmtpConfig();
  if (!config) {
    throw new Error("SMTP not configured. Set smtp_host, smtp_user, smtp_password in Settings.");
  }

  const pythonScript = `
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import sys

msg = MIMEMultipart()
msg['From'] = sys.argv[4]
msg['To'] = sys.argv[1]
msg['Subject'] = sys.argv[2]
msg.attach(MIMEText(sys.argv[3], 'plain'))

with smtplib.SMTP(sys.argv[5], int(sys.argv[6])) as server:
    server.starttls()
    server.login(sys.argv[7], sys.argv[8])
    server.send_message(msg)
`;

  await exec(
    "python3",
    [
      "-c", pythonScript,
      to, subject, body,
      config.from, config.host, String(config.port), config.user, config.password,
    ],
    { timeout: 30_000 }
  );
}

// ── Public API — tries Graph first, falls back to SMTP ──────────────

export async function sendEmail(
  to: string,
  subject: string,
  body: string
): Promise<void> {
  // Try Graph API first (uses same Azure creds as Teams)
  const graphConfig = await getGraphConfig();
  if (graphConfig) {
    try {
      await sendViaGraph(to, subject, body);
      return;
    } catch (e) {
      console.warn("[Email] Graph API failed, trying SMTP:", (e as Error).message);
    }
  }

  // Fallback to SMTP
  await sendViaSmtp(to, subject, body);
}

// ── Test function — verifies the configured email method works ──────

export async function testEmailConnection(): Promise<{
  ok: boolean;
  method: string;
  message: string;
}> {
  const graphConfig = await getGraphConfig();
  if (graphConfig) {
    try {
      const token = await getGraphToken(graphConfig);
      // Verify we can access the mailbox
      const response = await fetch(
        `https://graph.microsoft.com/v1.0/users/${graphConfig.from}/mailFolders/Inbox`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (response.ok) {
        return { ok: true, method: "graph", message: `Graph API connected as ${graphConfig.from}` };
      }
      const body = await response.text();
      return { ok: false, method: "graph", message: `Graph API error (${response.status}): ${body.slice(0, 200)}` };
    } catch (e) {
      return { ok: false, method: "graph", message: `Graph API: ${(e as Error).message}` };
    }
  }

  const smtpConfig = await getSmtpConfig();
  if (smtpConfig) {
    try {
      // Test SMTP connection without actually sending
      const testScript = `
import smtplib, sys
with smtplib.SMTP(sys.argv[1], int(sys.argv[2])) as server:
    server.starttls()
    server.login(sys.argv[3], sys.argv[4])
    print("OK")
`;
      await exec(
        "python3",
        ["-c", testScript, smtpConfig.host, String(smtpConfig.port), smtpConfig.user, smtpConfig.password],
        { timeout: 15_000 }
      );
      return { ok: true, method: "smtp", message: `SMTP connected to ${smtpConfig.host}` };
    } catch (e) {
      return { ok: false, method: "smtp", message: `SMTP: ${(e as Error).message}` };
    }
  }

  return { ok: false, method: "none", message: "No email method configured (need Graph or SMTP credentials)" };
}
