"use server";

import { prisma } from "@/lib/db";
import { getQueueStats as getQueueStatsLib } from "@/lib/messaging";

export async function getNotifications(unreadOnly: boolean = false) {
  const results = await prisma.notification.findMany({
    where: unreadOnly ? { read: false } : {},
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return results.map((n) => ({
    ...n,
    createdAt: n.createdAt.toISOString(),
  }));
}

export async function markAsRead(id: string) {
  await prisma.notification.update({
    where: { id },
    data: { read: true },
  });
}

export async function markAllAsRead() {
  await prisma.notification.updateMany({
    where: { read: false },
    data: { read: true },
  });
}

export async function getUnreadCount(): Promise<number> {
  return prisma.notification.count({ where: { read: false } });
}

export async function getQueueStats() {
  return getQueueStatsLib();
}
