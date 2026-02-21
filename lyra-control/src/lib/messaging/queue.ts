/**
 * Message delivery queue — reliable delivery with retry.
 * Writes messages to DB first (write-ahead), then delivers.
 * Failed deliveries retry up to MAX_RETRIES times.
 */

import { prisma } from "../db";
import { sendIMessage } from "./imessage";
import { sendEmail } from "./email";
import { sendWebhook } from "./webhook";
import { sendTeamsMessage } from "./teams";
import { sendSlackMessage } from "./slack";

const MAX_RETRIES = 3;

export async function enqueue(params: {
  channel: string;
  recipient: string;
  subject?: string;
  body: string;
}): Promise<string> {
  const msg = await prisma.messageQueue.create({
    data: {
      channel: params.channel,
      recipient: params.recipient,
      subject: params.subject,
      body: params.body,
      status: "pending",
    },
  });
  return msg.id;
}

export async function processQueue(): Promise<{
  sent: number;
  failed: number;
}> {
  const pending = await prisma.messageQueue.findMany({
    where: {
      status: "pending",
      retryCount: { lt: MAX_RETRIES },
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });

  let sent = 0;
  let failed = 0;

  for (const msg of pending) {
    try {
      await deliver(msg.channel, msg.recipient, msg.body, msg.subject);

      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: { status: "sent", sentAt: new Date() },
      });
      sent++;
    } catch (e) {
      const retryCount = msg.retryCount + 1;
      await prisma.messageQueue.update({
        where: { id: msg.id },
        data: {
          retryCount,
          lastError: (e as Error).message,
          status: retryCount >= MAX_RETRIES ? "failed" : "pending",
        },
      });
      failed++;
      console.error(
        `[MessageQueue] Failed to deliver ${msg.channel} message (attempt ${retryCount}):`,
        (e as Error).message
      );
    }
  }

  return { sent, failed };
}

async function deliver(
  channel: string,
  recipient: string,
  body: string,
  subject?: string | null
): Promise<void> {
  switch (channel) {
    case "imessage":
      await sendIMessage(recipient, body);
      break;
    case "email":
      await sendEmail(recipient, subject || "Lyra Notification", body);
      break;
    case "webhook":
      await sendWebhook(recipient, body, subject || undefined);
      break;
    case "teams":
      await sendTeamsMessage(recipient, body);
      break;
    case "slack":
      await sendSlackMessage(recipient, body);
      break;
    default:
      throw new Error(`Unknown channel: ${channel}`);
  }
}

export async function getQueueStats(): Promise<{
  pending: number;
  sent: number;
  failed: number;
}> {
  const [pending, sent, failed] = await Promise.all([
    prisma.messageQueue.count({ where: { status: "pending" } }),
    prisma.messageQueue.count({ where: { status: "sent" } }),
    prisma.messageQueue.count({ where: { status: "failed" } }),
  ]);
  return { pending, sent, failed };
}
