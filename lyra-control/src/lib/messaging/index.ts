/**
 * Messaging channel router — dispatches messages to configured channels.
 * Creates in-app Notification record + enqueues external channel deliveries.
 * Supports per-project routing with [JIRA_KEY] prefixing.
 */

import { prisma } from "../db";
import { enqueue, processQueue, getQueueStats } from "./queue";
import { ensureProjectChannel } from "./slack";

export { processQueue, getQueueStats };

export type MessageSeverity = "info" | "warning" | "critical";

interface ChannelConfig {
  imessage: { enabled: boolean; recipient: string };
  email: { enabled: boolean; recipient: string };
  webhook: { enabled: boolean; url: string };
  teams: { enabled: boolean; conversationRef: string };
  slack: { enabled: boolean; generalChannelId: string };
}

// ── Severity-to-channel routing defaults ────────────────────────────
// Users can override these in Settings

const DEFAULT_ROUTING: Record<MessageSeverity, string[]> = {
  info: ["in_app", "slack"],
  warning: ["in_app", "slack", "imessage"],
  critical: ["in_app", "slack", "imessage", "email"],
};

// ── Load channel config from DB ─────────────────────────────────────

async function getChannelConfig(): Promise<ChannelConfig> {
  const keys = [
    "imessage_enabled",
    "imessage_recipient",
    "email_enabled",
    "email_to",
    "webhook_enabled",
    "webhook_url",
    "teams_enabled",
    "teams_conversation_ref",
    "slack_enabled",
    "slack_general_channel_id",
  ];

  const settings = await prisma.setting.findMany({
    where: { key: { in: keys } },
  });

  const config: Record<string, string> = {};
  for (const s of settings) {
    config[s.key] = s.value;
  }

  return {
    imessage: {
      enabled: config.imessage_enabled === "true",
      recipient: config.imessage_recipient || "",
    },
    email: {
      enabled: config.email_enabled === "true",
      recipient: config.email_to || "",
    },
    webhook: {
      enabled: config.webhook_enabled === "true",
      url: config.webhook_url || "",
    },
    teams: {
      enabled: config.teams_enabled === "true",
      conversationRef: config.teams_conversation_ref || "",
    },
    slack: {
      enabled: config.slack_enabled === "true",
      generalChannelId: config.slack_general_channel_id || "",
    },
  };
}

async function getSeverityRouting(): Promise<
  Record<MessageSeverity, string[]>
> {
  const setting = await prisma.setting.findUnique({
    where: { key: "notification_routing" },
  });

  if (setting?.value) {
    try {
      return JSON.parse(setting.value);
    } catch {
      // Fall through to defaults
    }
  }

  return DEFAULT_ROUTING;
}

// ── Load per-project channel info ───────────────────────────────────

async function getProjectChannelInfo(projectId: string) {
  return prisma.project.findUnique({
    where: { id: projectId },
    select: {
      jiraKey: true,
      slackChannelId: true,
      webhookUrl: true,
      emailThreadPrefix: true,
    },
  });
}

// ── Main send function ──────────────────────────────────────────────

export async function sendNotification(params: {
  projectId?: string;
  severity: MessageSeverity;
  title: string;
  body: string;
}): Promise<void> {
  // Load per-project info if projectId provided
  const projectInfo = params.projectId
    ? await getProjectChannelInfo(params.projectId)
    : null;

  const jiraKey = projectInfo?.jiraKey;
  const prefix = jiraKey ? `[${jiraKey}] ` : "";

  // 1. Always create in-app notification
  await prisma.notification.create({
    data: {
      projectId: params.projectId,
      channel: "in_app",
      severity: params.severity,
      title: params.title,
      body: params.body,
    },
  });

  // 2. Route to external channels based on severity
  const routing = await getSeverityRouting();
  const channels = routing[params.severity] || ["in_app"];
  const config = await getChannelConfig();

  const prefixedTitle = `${prefix}${params.title}`;
  const message = `${prefixedTitle}\n\n${params.body}`;

  for (const channel of channels) {
    if (channel === "in_app") continue; // Already created above

    if (channel === "imessage" && config.imessage.enabled && config.imessage.recipient) {
      await enqueue({
        channel: "imessage",
        recipient: config.imessage.recipient,
        body: message,
      });
    }

    if (channel === "email" && config.email.enabled && config.email.recipient) {
      // Use [JIRA_KEY] in subject for per-project threading
      const threadPrefix = projectInfo?.emailThreadPrefix || jiraKey;
      const subject = threadPrefix
        ? `[${threadPrefix}] ${params.title}`
        : `[Lyra] ${params.title}`;

      await enqueue({
        channel: "email",
        recipient: config.email.recipient,
        subject,
        body: message,
      });
    }

    if (channel === "webhook") {
      // Use per-project webhook URL if set, fall back to global
      const webhookUrl = projectInfo?.webhookUrl || config.webhook.url;
      if (config.webhook.enabled && webhookUrl) {
        await enqueue({
          channel: "webhook",
          recipient: webhookUrl,
          subject: prefixedTitle,
          body: message,
        });
      }
    }

    if (channel === "teams" && config.teams.enabled && config.teams.conversationRef) {
      await enqueue({
        channel: "teams",
        recipient: config.teams.conversationRef,
        body: message,
      });
    }

    if (channel === "slack" && config.slack.enabled) {
      // Ensure project channel exists (creates if missing, recreates if deleted)
      let slackChannelId: string | null = null;
      if (params.projectId) {
        slackChannelId = await ensureProjectChannel(params.projectId);
      }
      // Fall back to #lyra-general
      if (!slackChannelId) {
        slackChannelId = config.slack.generalChannelId || null;
      }
      if (slackChannelId) {
        await enqueue({
          channel: "slack",
          recipient: slackChannelId,
          body: message,
        });
      }
    }
  }
}
