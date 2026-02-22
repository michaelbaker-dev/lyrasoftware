"use client";

import { useEffect, useState, useCallback } from "react";

interface TimelineEvent {
  id: string;
  type: "session" | "gate" | "audit" | "triage" | "memory";
  timestamp: string;
  title: string;
  details: string;
  status?: "success" | "failure" | "info" | "warning";
}

interface TicketPipeline {
  ticketKey: string;
  summary: string;
  status: "active" | "queued" | "abandoned" | "completed";
  attemptCount: number;
  totalCost: number;
  events: TimelineEvent[];
}

interface PipelineSummary {
  active: number;
  queued: number;
  abandoned: number;
  completed: number;
}

const STATUS_COLORS: Record<string, string> = {
  active: "bg-blue-500/20 text-blue-400 border-blue-500/30",
  queued: "bg-gray-500/20 text-gray-400 border-gray-500/30",
  abandoned: "bg-red-500/20 text-red-400 border-red-500/30",
  completed: "bg-green-500/20 text-green-400 border-green-500/30",
};

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

export default function PipelineActivity() {
  const [tickets, setTickets] = useState<TicketPipeline[]>([]);
  const [summary, setSummary] = useState<PipelineSummary>({ active: 0, queued: 0, abandoned: 0, completed: 0 });
  const [filter, setFilter] = useState<string>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

  const fetchPipeline = useCallback(async () => {
    try {
      const res = await fetch("/api/pipeline");
      if (!res.ok) return;
      const data = await res.json();
      setTickets(data.tickets || []);
      setSummary(data.summary || { active: 0, queued: 0, abandoned: 0, completed: 0 });
    } catch {
      // Silently fail — will retry on next poll
    }
  }, []);

  useEffect(() => {
    fetchPipeline();

    // Subscribe to SSE for real-time updates
    const es = new EventSource("/api/events");

    const refreshEvents = [
      "gate:passed", "gate:failed",
      "agent:completed", "agent:failed",
      "ticket:abandoned",
    ];

    for (const evt of refreshEvents) {
      es.addEventListener(evt, () => {
        fetchPipeline();
      });
    }

    // Also refresh on heartbeat (every 5s from SSE)
    es.addEventListener("heartbeat", () => {
      fetchPipeline();
    });

    return () => es.close();
  }, [fetchPipeline]);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleRetry = async (ticketKey: string) => {
    setRetrying((prev) => new Set(prev).add(ticketKey));
    try {
      // Find the triage entry for this ticket
      const triageRes = await fetch(`/api/triage?resolution=open`);
      const triageData = await triageRes.json();
      const entry = triageData.entries?.find(
        (e: { ticketKey: string }) => e.ticketKey === ticketKey
      );
      if (!entry) {
        // Try escalated entries
        const escRes = await fetch(`/api/triage?resolution=escalated`);
        const escData = await escRes.json();
        const escEntry = escData.entries?.find(
          (e: { ticketKey: string }) => e.ticketKey === ticketKey
        );
        if (escEntry) {
          await fetch("/api/triage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: escEntry.id, model: "claude-opus-4" }),
          });
        }
      } else {
        await fetch("/api/triage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: entry.id, model: "claude-opus-4" }),
        });
      }
      // Refresh data
      setTimeout(fetchPipeline, 2000);
    } catch (e) {
      console.error("Retry failed:", e);
    } finally {
      setRetrying((prev) => {
        const next = new Set(prev);
        next.delete(ticketKey);
        return next;
      });
    }
  };

  const filteredTickets = filter === "all"
    ? tickets
    : tickets.filter((t) => t.status === filter);

  const tabs = [
    { key: "all", label: "All", count: summary.active + summary.queued + summary.abandoned + summary.completed },
    { key: "active", label: "Active", count: summary.active },
    { key: "queued", label: "Queued", count: summary.queued },
    { key: "abandoned", label: "Abandoned", count: summary.abandoned },
    { key: "completed", label: "Completed", count: summary.completed },
  ];

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
      <h2 className="text-xl font-semibold text-gray-100 mb-4">Pipeline Activity</h2>

      {/* Summary cards */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        {[
          { label: "Active", value: summary.active, color: "text-blue-400" },
          { label: "Queued", value: summary.queued, color: "text-gray-400" },
          { label: "Abandoned", value: summary.abandoned, color: "text-red-400" },
          { label: "Completed", value: summary.completed, color: "text-green-400" },
        ].map((card) => (
          <div key={card.label} className="bg-gray-900 rounded-lg p-3 text-center">
            <div className={`text-2xl font-bold ${card.color}`}>{card.value}</div>
            <div className="text-xs text-gray-500 mt-1">{card.label}</div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 mb-4 border-b border-gray-700 pb-2">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={`px-3 py-1.5 text-sm rounded-t transition-colors ${
              filter === tab.key
                ? "bg-gray-700 text-white"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label} ({tab.count})
          </button>
        ))}
      </div>

      {/* Ticket list */}
      <div className="space-y-2 max-h-[600px] overflow-y-auto">
        {filteredTickets.length === 0 && (
          <p className="text-sm text-gray-500 py-4 text-center">No tickets in this category</p>
        )}
        {filteredTickets.map((ticket) => (
          <div key={ticket.ticketKey} className="bg-gray-900 rounded-lg border border-gray-700">
            {/* Ticket header */}
            <button
              onClick={() => toggleExpanded(ticket.ticketKey)}
              className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-800/50 transition-colors rounded-lg"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className={`px-2 py-0.5 text-xs rounded border ${STATUS_COLORS[ticket.status]}`}>
                  {ticket.status}
                </span>
                <span className="text-sm font-mono text-gray-200">{ticket.ticketKey}</span>
                <span className="text-sm text-gray-400 truncate">{ticket.summary}</span>
              </div>
              <div className="flex items-center gap-4 flex-shrink-0">
                <span className="text-xs text-gray-500">
                  {ticket.attemptCount} attempt{ticket.attemptCount !== 1 ? "s" : ""}
                </span>
                <span className="text-xs text-gray-500">
                  ${ticket.totalCost.toFixed(2)}
                </span>
                {ticket.status === "abandoned" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRetry(ticket.ticketKey);
                    }}
                    disabled={retrying.has(ticket.ticketKey)}
                    className="px-2 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded disabled:opacity-50 transition-colors"
                  >
                    {retrying.has(ticket.ticketKey) ? "Retrying..." : "Reset & Retry"}
                  </button>
                )}
                <span className="text-gray-500">{expanded.has(ticket.ticketKey) ? "\u25B2" : "\u25BC"}</span>
              </div>
            </button>

            {/* Expanded timeline */}
            {expanded.has(ticket.ticketKey) && (
              <div className="border-t border-gray-700 p-3">
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {ticket.events.length === 0 && (
                    <p className="text-xs text-gray-500">No events recorded</p>
                  )}
                  {ticket.events.map((event) => (
                    <div key={event.id} className="flex items-start gap-2 text-sm">
                      <span className={`flex-shrink-0 w-5 text-center font-bold ${EVENT_COLORS[event.status || "info"]}`}>
                        {EVENT_ICONS[event.status || "info"]}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className={EVENT_COLORS[event.status || "info"]}>
                            {event.title}
                          </span>
                          <span className="text-xs text-gray-600">{event.type}</span>
                          <span className="text-xs text-gray-600 ml-auto flex-shrink-0">
                            {relativeTime(event.timestamp)}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5 break-words">{event.details}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
