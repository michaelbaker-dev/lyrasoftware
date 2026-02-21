import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { retryTicket } from "@/lib/dispatcher";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await prisma.session.findUnique({
    where: { id },
    include: {
      agent: { include: { team: true } },
      gateRuns: { orderBy: { createdAt: "desc" } },
      triageLogs: { orderBy: { createdAt: "desc" } },
    },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Fetch all attempts for the same ticket (sibling sessions)
  const attempts = await prisma.session.findMany({
    where: { ticketKey: session.ticketKey, projectId: session.projectId },
    orderBy: { startedAt: "asc" },
    include: {
      agent: true,
      gateRuns: { take: 1, orderBy: { createdAt: "desc" } },
    },
  });

  return NextResponse.json({ session, attempts });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Look up the session to get ticketKey and projectId
  const session = await prisma.session.findUnique({
    where: { id },
    select: { ticketKey: true, projectId: true },
  });

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await req.json();
  const prompt: string | undefined = body.prompt;

  try {
    const result = await retryTicket(session.ticketKey, session.projectId, prompt);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
