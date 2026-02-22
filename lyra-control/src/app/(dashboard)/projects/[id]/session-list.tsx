"use client";

import { useState } from "react";
import SessionDetail from "./session-detail";

type SessionRow = {
  id: string;
  ticketKey: string;
  branch: string;
  status: string;
  cost: number;
  startedAt: string;
  completedAt: string | null;
  agent: { id: string; name: string; role: string };
  _count: { gateRuns: number };
};

const sessionStatusColor: Record<string, string> = {
  running: "text-blue-400",
  completed: "text-green-400",
  failed: "text-red-400",
  cancelled: "text-gray-500",
};

function formatDate(date: string | null | undefined): string {
  if (!date) return "\u2014";
  return new Date(date).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatCost(cost: number): string {
  if (cost < 0.01) return cost > 0 ? "<$0.01" : "$0.00";
  return `$${cost.toFixed(2)}`;
}

export default function SessionList({ sessions }: { sessions: SessionRow[] }) {
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  return (
    <>
      <h2 className="mb-4 text-lg font-semibold">Recent Sessions</h2>
      {sessions.length === 0 ? (
        <p className="text-sm text-gray-500">No sessions recorded yet.</p>
      ) : (
        <div className="space-y-2">
          {sessions.map((session) => (
            <div
              key={session.id}
              onClick={() => setSelectedSessionId(session.id)}
              className="flex items-center justify-between rounded-lg bg-gray-800 p-3 text-sm cursor-pointer hover:bg-gray-750 hover:bg-gray-700/50 transition-colors"
            >
              <div className="flex items-center gap-4">
                <span className="font-medium text-blue-400">
                  {session.ticketKey}
                </span>
                <span className="text-gray-400">{session.branch}</span>
                {session._count.gateRuns > 0 && (
                  <span className="text-xs text-gray-500" title="Has quality gate results">
                    QG
                  </span>
                )}
              </div>
              <div className="flex items-center gap-4">
                <span className="text-gray-500">
                  {formatDate(session.startedAt)}
                  {session.completedAt
                    ? ` \u2014 ${formatDate(session.completedAt)}`
                    : ""}
                </span>
                {session.cost != null && session.cost > 0 && (
                  <span className="text-gray-400">{formatCost(session.cost)}</span>
                )}
                <span
                  className={`min-w-[80px] text-right ${sessionStatusColor[session.status] ?? "text-gray-400"}`}
                >
                  {session.status}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {selectedSessionId && (
        <SessionDetail
          sessionId={selectedSessionId}
          onClose={() => setSelectedSessionId(null)}
        />
      )}
    </>
  );
}
