"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { CostUpdateEvent } from "@/lib/lyra-events";
import { api } from "@/lib/api";

interface ModelBreakdown {
  name: string;
  cost: number;
  percentage: number;
  color: string;
}

interface CostBuckets {
  today: number;
  week: number;
  month: number;
}

interface CostTickerLiveProps {
  initialCosts: CostBuckets;
  apiCosts: CostBuckets;
  subscriptionCosts: CostBuckets;
  modelBreakdown: ModelBreakdown[];
  projectId?: string;
}

export default function CostTickerLive({
  initialCosts,
  apiCosts: initialApiCosts,
  subscriptionCosts: initialSubCosts,
  modelBreakdown,
  projectId,
}: CostTickerLiveProps) {
  const [costs, setCosts] = useState(initialCosts);
  const [apiCosts, setApiCosts] = useState(initialApiCosts);
  const [subCosts, setSubCosts] = useState(initialSubCosts);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const connect = useCallback(() => {
    const es = new EventSource(api("/api/events"));

    es.addEventListener("cost:update", (event) => {
      try {
        const data = JSON.parse(event.data) as CostUpdateEvent & { model?: string };
        // Filter by project if scoped
        if (projectIdRef.current && data.projectId !== projectIdRef.current) return;
        if (data.cost > 0) {
          setCosts((prev) => ({
            today: prev.today + data.cost,
            week: prev.week + data.cost,
            month: prev.month + data.cost,
          }));

          // Route to API or subscription bucket based on model info
          const isSubscription = data.model?.includes("sonnet") ||
            data.model?.includes("opus") ||
            data.model?.includes("haiku");

          if (isSubscription) {
            setSubCosts((prev) => ({
              today: prev.today + data.cost,
              week: prev.week + data.cost,
              month: prev.month + data.cost,
            }));
          } else {
            setApiCosts((prev) => ({
              today: prev.today + data.cost,
              week: prev.week + data.cost,
              month: prev.month + data.cost,
            }));
          }
        }
      } catch {
        // Invalid JSON — skip
      }
    });

    es.onerror = () => {
      es.close();
      // Reconnect after 5s
      setTimeout(connect, 5000);
    };

    return es;
  }, []);

  useEffect(() => {
    const es = connect();
    return () => es.close();
  }, [connect]);

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
      <h2 className="text-xl font-semibold text-gray-100 mb-4">Cost Overview</h2>

      <div className="grid grid-cols-3 gap-4 mb-4">
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
          <p className="text-sm text-gray-400 mb-1">Today</p>
          <p className="text-2xl font-bold text-gray-100">${costs.today.toFixed(2)}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
          <p className="text-sm text-gray-400 mb-1">This Week</p>
          <p className="text-2xl font-bold text-gray-100">${costs.week.toFixed(2)}</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
          <p className="text-sm text-gray-400 mb-1">This Month</p>
          <p className="text-2xl font-bold text-gray-100">${costs.month.toFixed(2)}</p>
        </div>
      </div>

      {/* API vs Subscription breakdown */}
      <div className="grid grid-cols-2 gap-4 mb-6">
        <div className="bg-gray-900 rounded-lg p-3 border border-yellow-700/30">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-yellow-500" />
            <p className="text-xs font-medium text-yellow-400">API Spend</p>
          </div>
          <p className="text-lg font-bold text-gray-100">${apiCosts.month.toFixed(2)}</p>
          <p className="text-xs text-gray-500">Real charges (OpenRouter, Tavily)</p>
        </div>
        <div className="bg-gray-900 rounded-lg p-3 border border-indigo-700/30">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-indigo-500" />
            <p className="text-xs font-medium text-indigo-400">Subscription</p>
          </div>
          <p className="text-lg font-bold text-gray-100">${subCosts.month.toFixed(2)}</p>
          <p className="text-xs text-gray-500">Claude Max token value (flat rate)</p>
        </div>
      </div>

      <div className="border-t border-gray-700 pt-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Breakdown by Model</h3>
        <div className="space-y-3">
          {modelBreakdown.length === 0 && (
            <p className="text-sm text-gray-500">No session data this month</p>
          )}
          {modelBreakdown.map((model) => (
            <div key={model.name}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-gray-300">{model.name}</span>
                <span className="text-sm font-mono text-gray-100">
                  ${model.cost.toFixed(2)}{" "}
                  <span className="text-gray-400 text-xs">({model.percentage}%)</span>
                </span>
              </div>
              <div className="w-full bg-gray-700 rounded-full h-2">
                <div
                  className={`${model.color} h-2 rounded-full transition-all`}
                  style={{ width: `${model.percentage}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
