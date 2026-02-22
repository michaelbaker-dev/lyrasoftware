"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

interface DispatcherControlsProps {
  initialState: {
    running: boolean;
    pollInterval: number;
    messagesUsed: number;
    messageLimit: number;
    activeAgentCount: number;
  };
}

export function DispatcherControls({ initialState }: DispatcherControlsProps) {
  const [state, setState] = useState(initialState);
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(
    Math.floor(initialState.pollInterval / 1000)
  );

  // Countdown timer that resets each poll interval
  useEffect(() => {
    if (!state.running) {
      setCountdown(0);
      return;
    }

    setCountdown(Math.floor(state.pollInterval / 1000));
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) return Math.floor(state.pollInterval / 1000);
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [state.running, state.pollInterval]);

  const refreshState = useCallback(async () => {
    try {
      const res = await fetch(api("/api/dispatcher"));
      if (res.ok) {
        const data = await res.json();
        setState({
          running: data.running,
          pollInterval: data.pollInterval,
          messagesUsed: data.messagesUsed,
          messageLimit: data.messageLimit,
          activeAgentCount: data.activeAgentCount,
        });
      }
    } catch {
      // Silently ignore refresh errors
    }
  }, []);

  const sendAction = useCallback(
    async (action: "start" | "stop") => {
      setLoading(true);
      try {
        await fetch(api("/api/dispatcher"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        await refreshState();
      } catch {
        // Silently ignore action errors
      } finally {
        setLoading(false);
      }
    },
    [refreshState]
  );

  const handleRestart = useCallback(async () => {
    setLoading(true);
    try {
      await fetch(api("/api/dispatcher"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await fetch(api("/api/dispatcher"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start" }),
      });
      await refreshState();
    } catch {
      // Silently ignore restart errors
    } finally {
      setLoading(false);
    }
  }, [refreshState]);

  const formatCountdown = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}m ${s.toString().padStart(2, "0")}s`;
  };

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
      <h2 className="mb-4 text-lg font-semibold">Dispatcher Controls</h2>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full ${state.running ? "bg-green-500" : "bg-gray-600"}`}
          />
          <span className="text-sm">
            Dispatcher {state.running ? "running" : "stopped"}
          </span>
        </div>

        {state.running ? (
          <button
            disabled={loading}
            onClick={() => sendAction("stop")}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            Stop
          </button>
        ) : (
          <button
            disabled={loading}
            onClick={() => sendAction("start")}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
          >
            Start
          </button>
        )}

        <button
          disabled={loading}
          onClick={handleRestart}
          className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm hover:bg-gray-800 disabled:opacity-50"
        >
          Restart
        </button>

        <div className="ml-auto text-sm text-gray-400">
          {state.running ? (
            <>
              Next poll in {formatCountdown(countdown)} | Rate limit:{" "}
              {state.messagesUsed}/{state.messageLimit} messages used |{" "}
              {state.activeAgentCount} active agent
              {state.activeAgentCount !== 1 ? "s" : ""}
            </>
          ) : (
            <>
              Rate limit: {state.messagesUsed}/{state.messageLimit} messages
              used
            </>
          )}
        </div>
      </div>
    </div>
  );
}
