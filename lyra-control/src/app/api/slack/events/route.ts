/**
 * Slack Events API endpoint — receives messages from Slack channels.
 * Handles:
 * 1. url_verification challenge (required by Slack during setup)
 * 2. message events — routes to Lyra chat engine for responses
 *
 * Setup: In Slack App → Event Subscriptions, set Request URL to:
 *   https://<your-domain>/api/slack/events
 * Subscribe to bot events: message.channels
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { chatWithLyra, chatWithLyraGeneral } from "@/lib/lyra-chat";
import { sendSlackMessage } from "@/lib/messaging/slack";
import crypto from "crypto";

// ── Signature verification ──────────────────────────────────────────

async function verifySlackSignature(
  request: NextRequest,
  rawBody: string
): Promise<boolean> {
  const signingSecret = await prisma.setting
    .findUnique({ where: { key: "slack_signing_secret" } })
    .then((s) => s?.value);

  if (!signingSecret) {
    console.warn("[Slack Events] No signing secret configured — skipping verification");
    return true; // Allow in dev; in production, require it
  }

  const timestamp = request.headers.get("x-slack-request-timestamp");
  const signature = request.headers.get("x-slack-signature");

  if (!timestamp || !signature) return false;

  // Prevent replay attacks (5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", signingSecret)
      .update(sigBasestring)
      .digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature)
  );
}

// ── Find project by Slack channel ID ────────────────────────────────

async function findProjectByChannel(
  channelId: string
): Promise<{ id: string; jiraKey: string; name: string } | null> {
  return prisma.project.findFirst({
    where: { slackChannelId: channelId },
    select: { id: true, jiraKey: true, name: true },
  });
}

// ── Route handler ───────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Handle URL verification challenge BEFORE signature check
  // (Slack sends this during app setup to verify the endpoint)
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Verify Slack signature for all other requests
  const valid = await verifySlackSignature(request, rawBody);
  if (!valid) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // Handle event callbacks
  if (payload.type === "event_callback") {
    const event = payload.event as Record<string, string>;

    // Only handle message events (not bot messages, not message_changed, etc.)
    if (
      event.type === "message" &&
      !event.subtype &&
      !event.bot_id &&
      event.text
    ) {
      // Don't block Slack's 3-second timeout — process async
      handleSlackMessage(event).catch((e) => {
        console.error("[Slack Events] Error handling message:", (e as Error).message);
      });
    }

    // Acknowledge immediately (Slack requires 200 within 3 seconds)
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
}

// ── Async message handler ───────────────────────────────────────────

async function handleSlackMessage(
  event: Record<string, string>
): Promise<void> {
  const channelId = event.channel;
  const userMessage = event.text;
  const threadTs = event.thread_ts || event.ts; // Reply in thread if it's a thread, else start one

  // Find which project this channel belongs to
  const project = await findProjectByChannel(channelId);

  if (!project) {
    // Check if this is #lyra-general — full conversational AI
    const generalSetting = await prisma.setting.findUnique({
      where: { key: "slack_general_channel_id" },
    });
    if (generalSetting?.value === channelId) {
      try {
        const response = await chatWithLyraGeneral(userMessage);
        await sendSlackMessage(channelId, response, threadTs);
      } catch (e) {
        console.error("[Slack Events] General chat error:", (e as Error).message);
        await sendSlackMessage(
          channelId,
          `:warning: Sorry, I hit an error: ${(e as Error).message}`,
          threadTs
        );
      }
    }
    return;
  }

  // Route to Lyra chat engine (same as in-app chat)
  try {
    const response = await chatWithLyra(project.id, userMessage);
    await sendSlackMessage(channelId, response, threadTs);
  } catch (e) {
    await sendSlackMessage(
      channelId,
      `:warning: Sorry, I encountered an error: ${(e as Error).message}`,
      threadTs
    );
  }
}
