"use client";

import { useState, useEffect, useRef } from "react";
import { api } from "@/lib/api";

type ActiveAgent = {
  ticketKey: string;
  projectKey: string;
  startedAt: string;
  branch: string;
  sessionId: string;
  outputTail: string;
};

type DispatcherData = {
  running: boolean;
  activeAgentCount: number;
  agents: ActiveAgent[];
};

export function LiveAgents() {
  const [agents, setAgents] = useState<ActiveAgent[]>([]);
  const [running, setRunning] = useState(false);
  const outputLogsRef = useRef<Map<string, string[]>>(new Map());
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const es = new EventSource(api("/api/events"));

    es.addEventListener("dispatcher", (e) => {
      try {
        const data: DispatcherData = JSON.parse(e.data);
        setAgents(data.agents);
        setRunning(data.running);
      } catch {
        // Invalid data
      }
    });

    es.addEventListener("agent:output", (e) => {
      try {
        const data = JSON.parse(e.data) as {
          ticketKey: string;
          line: string;
        };
        const logs = outputLogsRef.current.get(data.ticketKey) || [];
        logs.push(data.line);
        // Keep last 50 lines
        if (logs.length > 50) logs.splice(0, logs.length - 50);
        outputLogsRef.current.set(data.ticketKey, logs);
        forceUpdate((n) => n + 1);
      } catch {
        // Invalid data
      }
    });

    return () => es.close();
  }, []);

  if (agents.length === 0) {
    return (
      <div className="rounded-xl border border-gray-800 bg-gray-900 p-5">
        <h2 className="text-lg font-semibold text-gray-200 mb-3">Live Agents</h2>
        <div className="text-center text-gray-500 py-4">
          {running ? "No active agents — dispatcher is waiting for work" : "Dispatcher is stopped"}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-200">Live Agents</h2>
        <span className="rounded-full bg-green-900/30 px-2.5 py-0.5 text-xs font-medium text-green-400">
          {agents.length} running
        </span>
      </div>

      <div className="grid gap-3">
        {agents.map((agent) => {
          const elapsed = Math.round(
            (Date.now() - new Date(agent.startedAt).getTime()) / 60_000
          );
          const realtimeLog = outputLogsRef.current.get(agent.ticketKey) || [];
          const displayOutput =
            realtimeLog.length > 0
              ? realtimeLog.join("").slice(-500)
              : agent.outputTail;

          return (
            <div
              key={agent.ticketKey}
              className="rounded-lg border border-gray-700 bg-gray-800/50 p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse" />
                    <span className="font-mono text-sm font-medium text-blue-400">
                      {agent.ticketKey}
                    </span>
                  </span>
                  <span className="text-xs text-gray-500">{agent.projectKey}</span>
                </div>
                <span className="text-xs text-gray-500">{elapsed}m elapsed</span>
              </div>

              <div className="text-xs text-gray-500">
                Branch: <span className="text-gray-400 font-mono">{agent.branch}</span>
              </div>

              {displayOutput && (
                <details open className="text-sm">
                  <summary className="cursor-pointer text-gray-500 hover:text-gray-300 text-xs">
                    Output tail
                  </summary>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-gray-900 p-2 text-xs text-gray-400 font-mono whitespace-pre-wrap">
                    {displayOutput}
                  </pre>
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
