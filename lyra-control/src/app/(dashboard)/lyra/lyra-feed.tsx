"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { api } from "@/lib/api";

interface FeedItem {
  id: string;
  type: "decision" | "observation" | "escalation" | "reflection" | "gate" | "triage";
  timestamp: string;
  title: string;
  details: string;
  status: "success" | "failure" | "warning" | "info";
  ticketKey?: string;
  confidence?: number;
}

interface ThinkingItem {
  id: string;
  source: string;
  phase: string;
  message: string;
  projectId?: string;
  ticketKey?: string;
  timestamp: number;
}

const EVENT_COLORS: Record<string, string> = {
  success: "text-green-400",
  failure: "text-red-400",
  warning: "text-yellow-400",
  info: "text-gray-400",
};

const EVENT_ICONS: Record<string, string> = {
  success: "\u2713",
  failure: "\u00d7",
  warning: "!",
  info: "\u2022",
};

const TYPE_BADGES: Record<string, string> = {
  decision: "bg-blue-500/20 text-blue-400",
  observation: "bg-gray-500/20 text-gray-400",
  escalation: "bg-yellow-500/20 text-yellow-400",
  reflection: "bg-purple-500/20 text-purple-400",
  gate: "bg-green-500/20 text-green-400",
  triage: "bg-red-500/20 text-red-400",
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function relativeTimeMs(ts: number): string {
  const diffMs = Date.now() - ts;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  return `${diffHours}h ago`;
}

const FILTER_TABS = [
  { key: "all", label: "All" },
  { key: "decision", label: "Decisions" },
  { key: "observation", label: "Observations" },
  { key: "escalation", label: "Escalations" },
  { key: "gate", label: "Gates" },
  { key: "triage", label: "Triage" },
];

const SOURCE_COLORS: Record<string, string> = {
  oversight: "text-cyan-400 bg-cyan-900/30",
  sprint: "text-blue-400 bg-blue-900/30",
  quality: "text-green-400 bg-green-900/30",
  triage: "text-yellow-400 bg-yellow-900/30",
};

export default function LyraFeed() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [filter, setFilter] = useState("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [thinkingItems, setThinkingItems] = useState<ThinkingItem[]>([]);
  const thinkingIdRef = useRef(0);
  const [liveOpen, setLiveOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [thinkingNow, setThinkingNow] = useState(false);

  const fetchFeed = useCallback(async () => {
    try {
      const res = await fetch(api("/api/lyra/feed?limit=200"));
      if (res.ok) {
        const data = await res.json();
        setItems(data.items || []);
      }
    } catch {
      // Silently fail
    }
  }, []);

  const triggerOversight = useCallback(async () => {
    if (thinkingNow) return;
    setThinkingNow(true);
    try {
      await fetch(api("/api/dispatcher"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "oversight" }),
      });
    } catch {
      setThinkingNow(false);
    }
  }, [thinkingNow]);

  useEffect(() => {
    fetchFeed();

    const es = new EventSource(api("/api/events"));
    const refreshEvents = [
      "lyra:decision",
      "notify",
      "gate:passed",
      "gate:failed",
      "failure:analyzed",
    ];

    for (const evt of refreshEvents) {
      es.addEventListener(evt, () => fetchFeed());
    }

    // Listen for live thinking events
    es.addEventListener("lyra:thinking", (e) => {
      try {
        const data = JSON.parse(e.data);
        const item: ThinkingItem = {
          id: `think-${++thinkingIdRef.current}`,
          source: data.source,
          phase: data.phase,
          message: data.message,
          projectId: data.projectId,
          ticketKey: data.ticketKey,
          timestamp: Date.now(),
        };
        setThinkingItems((prev) => [item, ...prev].slice(0, 200));

        // Clear spinner when oversight completes
        if (data.phase === "done" && data.source === "oversight") {
          setThinkingNow(false);
        }
      } catch {
        // Ignore malformed events
      }
    });

    return () => {
      es.close();
    };
  }, [fetchFeed]);

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = filter === "all" ? items : items.filter((i) => i.type === filter);

  const filterCounts: Record<string, number> = {
    all: items.length,
    decision: items.filter((i) => i.type === "decision").length,
    observation: items.filter((i) => i.type === "observation").length,
    escalation: items.filter((i) => i.type === "escalation").length,
    gate: items.filter((i) => i.type === "gate").length,
    triage: items.filter((i) => i.type === "triage").length,
  };

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-4 flex flex-col h-full">
      {/* Title row with Think Now button */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-100">Thinking Feed</h2>
        <button
          onClick={triggerOversight}
          disabled={thinkingNow}
          className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            thinkingNow
              ? "bg-cyan-900/40 text-cyan-400 cursor-not-allowed"
              : "bg-cyan-600 text-white hover:bg-cyan-500"
          }`}
        >
          {thinkingNow ? (
            <>
              <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Thinking…
            </>
          ) : (
            <>
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
              </svg>
              Think Now
            </>
          )}
        </button>
      </div>

      {/* Collapsible Live Thinking section */}
      <div className="mb-3 bg-gray-900/50 border border-cyan-900/30 rounded-lg">
        <button
          onClick={() => setLiveOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left"
        >
          <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
            {thinkingItems.length > 0 ? (
              <>
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
              </>
            ) : (
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-gray-600" />
            )}
          </span>
          <span className="text-xs font-semibold text-green-400 uppercase tracking-wider">
            Live Thinking
          </span>
          <span className="text-[10px] text-gray-500 ml-1">
            ({thinkingItems.length})
          </span>
          <span className="text-gray-500 text-xs ml-auto flex-shrink-0">
            {liveOpen ? "\u25B2" : "\u25BC"}
          </span>
        </button>
        {liveOpen && (
          <div className="px-3 pb-3 space-y-1 max-h-64 overflow-y-auto">
            {thinkingItems.length === 0 && (
              <p className="text-xs text-gray-600 py-2 text-center">
                No thinking events yet — click Think Now to trigger
              </p>
            )}
            {thinkingItems.map((item) => (
              <div
                key={item.id}
                className={`flex items-center gap-2 text-xs ${
                  item.phase === "start" ? "border-t border-cyan-900/20 pt-1.5 mt-1" : ""
                }`}
              >
                <span
                  className={`font-mono px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${
                    SOURCE_COLORS[item.source] || "text-cyan-400 bg-cyan-900/30"
                  }`}
                >
                  {item.source}
                </span>
                <span className="text-gray-300 truncate">{item.message}</span>
                {item.ticketKey && (
                  <span className="font-mono text-gray-500 text-[10px] flex-shrink-0">
                    {item.ticketKey}
                  </span>
                )}
                <span className="text-gray-600 text-[10px] ml-auto flex-shrink-0">
                  {relativeTimeMs(item.timestamp)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Collapsible History Feed section */}
      <div className="flex-1 flex flex-col min-h-0 bg-gray-900/30 border border-gray-700/50 rounded-lg">
        <button
          onClick={() => setHistoryOpen((v) => !v)}
          className="w-full flex items-center gap-2 px-3 py-2 text-left flex-shrink-0"
        >
          <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider">
            History
          </span>
          <span className="text-[10px] text-gray-500 ml-1">
            ({items.length})
          </span>
          <span className="text-gray-500 text-xs ml-auto flex-shrink-0">
            {historyOpen ? "\u25B2" : "\u25BC"}
          </span>
        </button>

        {historyOpen && (
          <>
            {/* Filter tabs */}
            <div className="flex gap-1 px-3 pb-2 border-b border-gray-700 flex-wrap">
              {FILTER_TABS.map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setFilter(tab.key)}
                  className={`px-3 py-1.5 text-xs rounded-t transition-colors ${
                    filter === tab.key
                      ? "bg-gray-700 text-white"
                      : "text-gray-400 hover:text-gray-200"
                  }`}
                >
                  {tab.label} ({filterCounts[tab.key] || 0})
                </button>
              ))}
            </div>

            {/* Feed items */}
            <div className="space-y-1.5 overflow-y-auto flex-1 p-3 max-h-[calc(100vh-480px)]">
              {filtered.length === 0 && (
                <p className="text-sm text-gray-500 py-4 text-center">
                  No items to display
                </p>
              )}
              {filtered.map((item) => (
                <div
                  key={item.id}
                  className="bg-gray-900 rounded border border-gray-700 hover:border-gray-600 transition-colors"
                >
                  <button
                    onClick={() => toggleExpanded(item.id)}
                    className="w-full flex items-start gap-2 p-2.5 text-left"
                  >
                    <span
                      className={`flex-shrink-0 w-5 text-center font-bold mt-0.5 ${EVENT_COLORS[item.status]}`}
                    >
                      {EVENT_ICONS[item.status]}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={`text-sm ${EVENT_COLORS[item.status]}`}
                        >
                          {item.title}
                        </span>
                        <span
                          className={`px-1.5 py-0.5 text-[10px] rounded ${TYPE_BADGES[item.type]}`}
                        >
                          {item.type}
                        </span>
                        {item.ticketKey && (
                          <span className="text-[10px] font-mono text-gray-500">
                            {item.ticketKey}
                          </span>
                        )}
                        <span className="text-[10px] text-gray-600 ml-auto flex-shrink-0">
                          {relativeTime(item.timestamp)}
                        </span>
                      </div>
                    </div>
                    <span className="text-gray-600 text-xs mt-1 flex-shrink-0">
                      {expanded.has(item.id) ? "\u25B2" : "\u25BC"}
                    </span>
                  </button>
                  {expanded.has(item.id) && (
                    <div className="border-t border-gray-700 px-3 py-2">
                      <p className="text-xs text-gray-400 whitespace-pre-wrap break-words">
                        {item.details}
                      </p>
                      {item.confidence !== undefined && (
                        <p className="text-[10px] text-gray-600 mt-1">
                          Confidence: {(item.confidence * 100).toFixed(0)}%
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
