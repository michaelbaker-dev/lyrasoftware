/**
 * Chat API — per-project conversation with Lyra.
 * GET: returns recent chat messages for initial load.
 * POST: sends a user message and returns Lyra's response.
 */

import { NextRequest, NextResponse } from "next/server";
import { chatWithLyra, getRecentMessages } from "@/lib/lyra-chat";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const messages = await getRecentMessages(id, 20);
    // Return in chronological order (DB returns desc)
    return NextResponse.json({ messages: messages.reverse() });
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const body = await request.json();
    const message = body.message?.trim();

    if (!message) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    const response = await chatWithLyra(id, message, body.useWebSearch ?? false);
    return NextResponse.json({ response });
  } catch (e) {
    console.error("[Chat API] Error:", (e as Error).message);
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
