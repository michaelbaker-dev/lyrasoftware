import { NextRequest, NextResponse } from "next/server";
import { chatWithLyraGeneral } from "@/lib/lyra-chat";
import { prisma } from "@/lib/db";

export async function GET() {
  const messages = await prisma.chatMessage.findMany({
    where: { projectId: null },
    orderBy: { createdAt: "desc" },
    take: 30,
    select: {
      id: true,
      role: true,
      content: true,
      metadata: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ messages: messages.reverse() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "Message is required" }, { status: 400 });
  }

  const response = await chatWithLyraGeneral(message, body.useWebSearch ?? false);
  return NextResponse.json({ response });
}
