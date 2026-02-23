import { prisma } from "@/lib/db";
import LyraStatusBar from "./lyra-status-bar";
import LyraFeed from "./lyra-feed";
import LyraChatPanel from "./lyra-chat-panel";

export const dynamic = "force-dynamic";

export default async function LyraPage() {
  // Pre-fetch summary counts
  const now = new Date();
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const [decisions24h, openEscalations, gatesPassed, gatesFailed, openTriage] =
    await Promise.all([
      prisma.lyraMemory.count({
        where: {
          category: "decision",
          createdAt: { gte: twentyFourHoursAgo },
        },
      }),
      prisma.lyraMemory.count({
        where: { category: "escalation" },
      }),
      prisma.qualityGateRun.count({
        where: { passed: true },
      }),
      prisma.qualityGateRun.count({
        where: { passed: false },
      }),
      prisma.triageLog.count({
        where: { resolution: "open" },
      }),
    ]);

  const initialSummary = {
    decisions24h,
    openEscalations,
    gatesPassed,
    gatesFailed,
    openTriage,
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-100">Lyra Center</h1>
        <p className="text-sm text-gray-500 mt-1">
          Lyra&apos;s thinking, decisions, and live chat
        </p>
      </div>

      <LyraStatusBar initialSummary={initialSummary} />

      <div className="grid grid-cols-5 gap-6" style={{ minHeight: "calc(100vh - 280px)" }}>
        <div className="col-span-3">
          <LyraFeed />
        </div>
        <div className="col-span-2">
          <LyraChatPanel />
        </div>
      </div>
    </div>
  );
}
