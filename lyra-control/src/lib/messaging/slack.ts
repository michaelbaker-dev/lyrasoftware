/**
 * Slack channel — sends messages via Slack Bot API.
 * Creates per-project channels and posts notifications.
 */

import { prisma } from "../db";

async function getSlackConfig(): Promise<{ botToken: string; ownerUserId: string | null } | null> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["slack_bot_token", "slack_enabled", "slack_owner_user_id"] } },
  });

  const config: Record<string, string> = {};
  for (const s of settings) config[s.key] = s.value;

  if (config.slack_enabled !== "true" || !config.slack_bot_token) {
    return null;
  }

  return { botToken: config.slack_bot_token, ownerUserId: config.slack_owner_user_id || null };
}

/**
 * Auto-detect the bot installer's user ID via auth.test and save it
 * as slack_owner_user_id if not already set.
 * Returns the user ID if detected/already set, null otherwise.
 */
async function autoDetectOwnerUserId(botToken: string): Promise<string | null> {
  try {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!data.ok || !data.user_id) return null;

    // Check if already set
    const existing = await prisma.setting.findUnique({
      where: { key: "slack_owner_user_id" },
    });
    if (existing?.value) return existing.value;

    // Save auto-detected user ID
    await prisma.setting.upsert({
      where: { key: "slack_owner_user_id" },
      update: { value: data.user_id },
      create: { key: "slack_owner_user_id", value: data.user_id },
    });
    console.log(`[Slack] Auto-detected owner user ID: ${data.user_id}`);
    return data.user_id;
  } catch (e) {
    console.warn("[Slack] Failed to auto-detect owner user ID:", e);
    return null;
  }
}

/**
 * Invite the workspace owner to a channel (if configured).
 * Silently ignores "already_in_channel" errors.
 */
async function inviteOwner(botToken: string, channelId: string, ownerUserId: string): Promise<void> {
  try {
    const res = await fetch("https://slack.com/api/conversations.invite", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId, users: ownerUserId }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();
    if (!data.ok && data.error !== "already_in_channel") {
      console.warn(`[Slack] Failed to invite owner to ${channelId}: ${data.error}`);
    }
  } catch (e) {
    console.warn(`[Slack] inviteOwner error:`, e);
  }
}

async function joinChannel(botToken: string, channelId: string): Promise<void> {
  const res = await fetch("https://slack.com/api/conversations.join", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ channel: channelId }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  // "already_in_channel" is fine, anything else that's not ok is a real error
  if (!data.ok && data.error !== "already_in_channel") {
    throw new Error(`Slack join failed: ${data.error}`);
  }
}

/**
 * Send a message to a Slack channel. Returns the message timestamp (for threading).
 */
export async function sendSlackMessage(
  channelId: string,
  text: string,
  threadTs?: string
): Promise<string> {
  const config = await getSlackConfig();
  if (!config) {
    throw new Error("Slack not configured. Set slack_bot_token and enable Slack in Settings.");
  }

  // Ensure bot is a member of the channel before posting
  await joinChannel(config.botToken, channelId);

  const payload: Record<string, string> = { channel: channelId, text };
  if (threadTs) {
    payload.thread_ts = threadTs;
  }

  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Slack API error: ${data.error}`);
  }

  return data.ts; // message timestamp, used as thread_ts for replies
}

/**
 * Start a Slack thread and track it in the database.
 * Returns the thread timestamp for posting replies.
 */
export async function startSlackThread(
  projectId: string,
  type: string,
  headerText: string,
  label?: string
): Promise<{ threadTs: string; channelId: string }> {
  // Ensure the project channel exists (creates or recreates if deleted)
  const channelId = await ensureProjectChannel(projectId);
  if (!channelId) {
    throw new Error("Project has no Slack channel and one could not be created");
  }

  const threadTs = await sendSlackMessage(channelId, headerText);

  // Store thread reference
  await prisma.slackThread.create({
    data: {
      projectId,
      type,
      threadTs,
      channelId,
      label,
    },
  });

  return { threadTs, channelId };
}

/**
 * Reply in an existing Slack thread.
 */
export async function replyInThread(
  channelId: string,
  threadTs: string,
  text: string
): Promise<void> {
  await sendSlackMessage(channelId, text, threadTs);
}

/**
 * Find the most recent thread of a given type for a project.
 */
export async function getLatestThread(
  projectId: string,
  type: string
): Promise<{ threadTs: string; channelId: string } | null> {
  const thread = await prisma.slackThread.findFirst({
    where: { projectId, type },
    orderBy: { createdAt: "desc" },
  });

  if (!thread) return null;
  return { threadTs: thread.threadTs, channelId: thread.channelId };
}

export async function createSlackChannel(
  name: string
): Promise<string> {
  const config = await getSlackConfig();
  if (!config) {
    throw new Error("Slack not configured");
  }

  // Slack channel names: lowercase, no spaces, max 80 chars
  const channelName = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);

  const response = await fetch("https://slack.com/api/conversations.create", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: channelName, is_private: false }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json();

  if (!data.ok) {
    // If channel already exists, try to find it
    if (data.error === "name_taken") {
      const listResponse = await fetch(
        `https://slack.com/api/conversations.list?types=public_channel&limit=200`,
        {
          headers: { Authorization: `Bearer ${config.botToken}` },
          signal: AbortSignal.timeout(15_000),
        }
      );
      const listData = await listResponse.json();
      const existing = listData.channels?.find(
        (ch: { name: string }) => ch.name === channelName
      );
      if (existing) {
        // Auto-invite owner to existing channel
        if (config.ownerUserId) {
          await inviteOwner(config.botToken, existing.id, config.ownerUserId);
        }
        return existing.id;
      }
    }
    throw new Error(`Slack createChannel error: ${data.error}`);
  }

  const channelId = data.channel.id;

  // Auto-invite the workspace owner so they see every channel Lyra creates
  if (config.ownerUserId) {
    await inviteOwner(config.botToken, channelId, config.ownerUserId);
  }

  return channelId;
}

export async function setupProjectChannel(
  projectId: string
): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jiraKey: true, name: true, slackChannelId: true },
  });

  if (!project) throw new Error("Project not found");
  if (project.slackChannelId) return project.slackChannelId;

  const channelName = `lyra-${project.jiraKey.toLowerCase()}`;
  const channelId = await createSlackChannel(channelName);

  // Store channel ID on project
  await prisma.project.update({
    where: { id: projectId },
    data: { slackChannelId: channelId },
  });

  // Post welcome message
  await sendSlackMessage(
    channelId,
    `*Lyra is now managing ${project.name} (${project.jiraKey})*\n` +
      `This channel will receive project-specific notifications, sprint updates, and alerts.\n` +
      `Managed by Lyra Control.`
  );

  return channelId;
}

/**
 * Ensure a project's Slack channel exists and is usable.
 * Creates `#lyra-{jirakey}` if it doesn't exist.
 * Recreates and updates the stored ID if the channel was deleted.
 */
export async function ensureProjectChannel(
  projectId: string
): Promise<string | null> {
  const config = await getSlackConfig();
  if (!config) return null;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { jiraKey: true, name: true, slackChannelId: true },
  });
  if (!project) return null;

  const channelName = `lyra-${project.jiraKey.toLowerCase()}`;

  // If we have a stored channel ID, verify it still exists
  if (project.slackChannelId) {
    const ok = await verifyChannel(config.botToken, project.slackChannelId);
    if (ok) return project.slackChannelId;

    // Channel was deleted — clear stale ID and recreate
    console.warn(
      `[Slack] Channel ${project.slackChannelId} for ${project.jiraKey} no longer exists — recreating #${channelName}`
    );
  }

  // Create (or find) the channel
  try {
    const channelId = await createSlackChannel(channelName);

    await prisma.project.update({
      where: { id: projectId },
      data: { slackChannelId: channelId },
    });

    await sendSlackMessage(
      channelId,
      project.slackChannelId
        ? `*Lyra reconnected to ${project.name} (${project.jiraKey})*\nPrevious channel was deleted — this is the new project channel.`
        : `*Lyra is now managing ${project.name} (${project.jiraKey})*\nThis channel will receive project-specific notifications, sprint updates, and alerts.`
    );

    console.log(`[Slack] Project channel #${channelName} ready (${channelId})`);
    return channelId;
  } catch (e) {
    console.error(`[Slack] Failed to ensure channel for ${project.jiraKey}:`, e);
    return null;
  }
}

/**
 * Verify a Slack channel still exists and is accessible.
 */
async function verifyChannel(
  botToken: string,
  channelId: string
): Promise<boolean> {
  try {
    const res = await fetch(
      `https://slack.com/api/conversations.info?channel=${channelId}`,
      {
        headers: { Authorization: `Bearer ${botToken}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    const data = await res.json();
    return data.ok === true && !data.channel?.is_archived;
  } catch {
    return false;
  }
}

/**
 * Ensure #lyra-general exists. Creates it if missing, stores channel ID in settings.
 * Returns the channel ID.
 */
export async function ensureGeneralChannel(): Promise<string> {
  // Check if already configured
  const existing = await prisma.setting.findUnique({
    where: { key: "slack_general_channel_id" },
  });
  if (existing?.value) return existing.value;

  // Create #lyra-general
  const channelId = await createSlackChannel("lyra-general");

  await prisma.setting.upsert({
    where: { key: "slack_general_channel_id" },
    update: { value: channelId },
    create: { key: "slack_general_channel_id", value: channelId },
  });

  await sendSlackMessage(
    channelId,
    "*Welcome to #lyra-general*\nThis channel receives cross-project notifications from Lyra. " +
      "Per-project channels will be created automatically when projects are onboarded."
  );

  return channelId;
}

/**
 * Re-invite the owner to a specific channel.
 * Auto-detects the owner user ID if not already configured.
 */
export async function reinviteOwner(channelId: string): Promise<{
  ok: boolean;
  message: string;
}> {
  const config = await getSlackConfig();
  if (!config) {
    return { ok: false, message: "Slack not configured" };
  }

  let userId = config.ownerUserId;
  if (!userId) {
    userId = await autoDetectOwnerUserId(config.botToken);
  }
  if (!userId) {
    return { ok: false, message: "Could not determine owner user ID. Set it in Settings > Channels." };
  }

  await inviteOwner(config.botToken, channelId, userId);
  return { ok: true, message: `Invited user ${userId} to channel` };
}

export async function testSlackConnection(): Promise<{
  ok: boolean;
  message: string;
}> {
  const config = await getSlackConfig();
  if (!config) {
    return { ok: false, message: "Slack bot token not configured or not enabled" };
  }

  try {
    // Verify auth
    const response = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.botToken}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    const data = await response.json();
    if (!data.ok) {
      return { ok: false, message: `Slack auth failed: ${data.error}` };
    }

    // Auto-detect and save owner user ID if not already set
    let userIdNote = "";
    if (data.user_id && !config.ownerUserId) {
      await prisma.setting.upsert({
        where: { key: "slack_owner_user_id" },
        update: { value: data.user_id },
        create: { key: "slack_owner_user_id", value: data.user_id },
      });
      userIdNote = ` | Auto-saved owner user ID: ${data.user_id}`;
    }

    // Auto-create #lyra-general if it doesn't exist, then send test message
    try {
      const channelId = await ensureGeneralChannel();
      await sendSlackMessage(
        channelId,
        "Lyra test message — if you see this, the Slack channel is working."
      );
      return {
        ok: true,
        message: `Connected to "${data.team}" + test message sent to #lyra-general${userIdNote}`,
      };
    } catch (e) {
      return {
        ok: true,
        message: `Connected to "${data.team}" but #lyra-general setup failed: ${(e as Error).message}${userIdNote}`,
      };
    }
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
