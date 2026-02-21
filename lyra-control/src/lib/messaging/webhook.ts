/**
 * Webhook channel — generic POST to any URL (Slack, Discord, etc.).
 */

export async function sendWebhook(
  url: string,
  body: string,
  title?: string
): Promise<void> {
  const payload = JSON.stringify({
    text: title ? `**${title}**\n${body}` : body,
    content: body, // Discord format
    title,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Webhook POST failed (${response.status}): ${text}`);
  }
}
