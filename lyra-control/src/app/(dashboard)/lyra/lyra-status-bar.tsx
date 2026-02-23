"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface FeedSummary {
  decisions24h: number;
  openEscalations: number;
  gatesPassed: number;
  gatesFailed: number;
  openTriage: number;
}

export default function LyraStatusBar({
  initialSummary,
}: {
  initialSummary: FeedSummary;
}) {
  const [summary, setSummary] = useState<FeedSummary>(initialSummary);

  useEffect(() => {
    const es = new EventSource(api("/api/events"));

    const refreshEvents = [
      "lyra:decision",
      "notify",
      "gate:passed",
      "gate:failed",
      "failure:analyzed",
    ];

    const refresh = async () => {
      try {
        const res = await fetch(api("/api/lyra/feed?limit=1"));
        if (res.ok) {
          const data = await res.json();
          if (data.summary) setSummary(data.summary);
        }
      } catch {
        // Silently fail
      }
    };

    for (const evt of refreshEvents) {
      es.addEventListener(evt, () => refresh());
    }

    return () => es.close();
  }, []);

  const cards = [
    { label: "Decisions (24h)", value: summary.decisions24h, color: "text-blue-400", bg: "bg-blue-500/10" },
    { label: "Escalations", value: summary.openEscalations, color: "text-yellow-400", bg: "bg-yellow-500/10" },
    { label: "Gates Passed", value: summary.gatesPassed, color: "text-green-400", bg: "bg-green-500/10" },
    { label: "Gates Failed", value: summary.gatesFailed, color: "text-red-400", bg: "bg-red-500/10" },
    { label: "Open Triage", value: summary.openTriage, color: "text-purple-400", bg: "bg-purple-500/10" },
  ];

  return (
    <div className="grid grid-cols-5 gap-3 mb-6">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`${card.bg} rounded-lg p-3 text-center border border-gray-700`}
        >
          <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
          <div className="text-xs text-gray-500 mt-1">{card.label}</div>
        </div>
      ))}
    </div>
  );
}
