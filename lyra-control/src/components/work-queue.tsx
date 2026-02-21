"use client";

import { useState } from "react";

type Ticket = {
  key: string;
  summary: string;
  assignee: string;
  priority: string;
};

type WorkQueueProps = {
  tickets: {
    "To Do": Ticket[];
    "In Progress": Ticket[];
    "Code Review": Ticket[];
    Done: Ticket[];
  };
};

const priorityColors: Record<string, string> = {
  Critical: "text-red-400",
  High: "text-orange-400",
  Medium: "text-yellow-400",
  Low: "text-gray-400",
};

export default function WorkQueue({ tickets }: WorkQueueProps) {
  const tabs = ["To Do", "In Progress", "Code Review", "Done"] as const;
  const [activeTab, setActiveTab] = useState<(typeof tabs)[number]>("In Progress");

  const currentTickets = tickets[activeTab] || [];

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
      <h2 className="text-xl font-semibold text-gray-100 mb-4">Work Queue</h2>

      <div className="flex space-x-1 mb-4 border-b border-gray-700">
        {tabs.map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors ${
              activeTab === tab
                ? "text-blue-400 border-b-2 border-blue-400"
                : "text-gray-400 hover:text-gray-300"
            }`}
          >
            {tab}
            <span className="ml-2 text-xs text-gray-500">
              ({tickets[tab]?.length || 0})
            </span>
          </button>
        ))}
      </div>

      {currentTickets.length === 0 ? (
        <p className="text-sm text-gray-500 py-4 text-center">No tickets in this column</p>
      ) : (
        <div className="space-y-3">
          {currentTickets.map((ticket, idx) => (
            <div
              key={idx}
              className="bg-gray-900 border border-gray-700 rounded p-4 hover:border-gray-600 transition-colors"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center space-x-3 mb-2">
                    <span className="text-sm font-mono text-blue-400">{ticket.key}</span>
                    <span className={`text-xs font-medium ${priorityColors[ticket.priority] || "text-gray-400"}`}>
                      {ticket.priority}
                    </span>
                  </div>
                  <p className="text-sm text-gray-100 mb-2">{ticket.summary}</p>
                  <p className="text-xs text-gray-400">
                    Assignee: <span className="text-gray-300 font-mono">{ticket.assignee}</span>
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
