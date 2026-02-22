"use client";

import { useState, useTransition } from "react";
import { removeAgent } from "./team-actions";

type UnassignedAgent = {
  id: string;
  name: string;
  role: string;
  status: string;
  currentTicket: string | null;
};

const agentStatusColor: Record<string, string> = {
  idle: "text-gray-500",
  running: "text-green-400",
  errored: "text-red-400",
  "rate-limited": "text-yellow-400",
};

export default function UnassignedAgents({
  agents: initialAgents,
}: {
  agents: UnassignedAgent[];
}) {
  const [agents, setAgents] = useState(initialAgents);
  const [isPending, startTransition] = useTransition();

  if (agents.length === 0) return null;

  const handleDelete = (agentId: string, agentName: string) => {
    if (!confirm(`Permanently delete agent "${agentName}"?`)) return;
    startTransition(async () => {
      const result = await removeAgent(agentId);
      if (result.success) {
        setAgents((prev) => prev.filter((a) => a.id !== agentId));
      }
    });
  };

  return (
    <div className="mt-4 pt-4 border-t border-gray-800">
      <h3 className="text-sm font-medium text-gray-500 mb-2">Unassigned Agents</h3>
      <div className="space-y-1">
        {agents.map((agent) => (
          <div
            key={agent.id}
            className="flex items-center justify-between text-sm py-1.5 px-2 rounded hover:bg-gray-800/50 group"
          >
            <div className="flex items-center gap-3">
              <span className="font-medium text-gray-300">{agent.name}</span>
              <span className="capitalize text-gray-500">{agent.role}</span>
              <span className={agentStatusColor[agent.status] ?? "text-gray-400"}>
                {agent.status}
              </span>
              {agent.currentTicket && (
                <span className="text-blue-400">{agent.currentTicket}</span>
              )}
            </div>
            <button
              onClick={() => handleDelete(agent.id, agent.name)}
              disabled={isPending || agent.status === "running"}
              className="text-xs text-red-500/50 hover:text-red-400 cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-30 disabled:cursor-not-allowed"
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
