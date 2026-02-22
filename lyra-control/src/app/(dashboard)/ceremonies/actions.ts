"use server";

import { prisma } from "@/lib/db";
import { runDailyStandup } from "@/lib/ceremonies";

export async function getCeremonyHistory(projectId?: string) {
  const entries = await prisma.lyraMemory.findMany({
    where: {
      category: { in: ["observation", "reflection"] },
      ...(projectId ? { projectId } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { project: { select: { name: true } } },
  });

  return entries.map((e) => ({
    id: e.id,
    category: e.category,
    content: e.content,
    createdAt: e.createdAt.toISOString(),
    projectName: e.project?.name,
  }));
}

export async function getProjects() {
  return prisma.project.findMany({
    where: { status: "active" },
    select: { id: true, name: true },
  });
}

export async function triggerStandup() {
  await runDailyStandup();
}
