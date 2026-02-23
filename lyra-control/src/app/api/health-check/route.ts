import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { runHealthCheck } from "@/lib/project-health-check";

export async function POST(request: Request) {
  try {
    const { projectId, autoFix = false } = await request.json();

    if (!projectId) {
      return NextResponse.json({ error: "projectId is required" }, { status: 400 });
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, path: true, name: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const result = await runHealthCheck({
      projectId: project.id,
      projectPath: project.path,
      mode: "full",
      autoFix,
    });

    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: 500 }
    );
  }
}
