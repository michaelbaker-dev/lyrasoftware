"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  getModelCatalog,
  getLastModelSelection,
  saveLastModelSelection,
  type CatalogModel,
} from "@/app/settings/actions";

// ── Helpers ──────────────────────────────────────────────────────────

function formatCost(cost: number | null): string {
  if (cost === null) return "Max sub";
  if (cost === 0) return "Free";
  return `$${cost.toFixed(2)}/M`;
}

function formatCostShort(cost: number | null): string {
  if (cost === null) return "varies";
  if (cost === 0) return "Free";
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(0)}`;
}

function estimateCost(model: CatalogModel, inputTokens: number, outputTokens: number): string {
  if (model.promptCostPerM === null || model.completionCostPerM === null) return "varies";
  const cost =
    (inputTokens / 1_000_000) * model.promptCostPerM +
    (outputTokens / 1_000_000) * model.completionCostPerM;
  if (cost < 0.01) return "<$0.01";
  return `~$${cost.toFixed(2)}`;
}

function scoreBadgeColor(score: number): string {
  if (score >= 90) return "text-green-400";
  if (score >= 70) return "text-blue-400";
  if (score >= 50) return "text-yellow-400";
  return "text-gray-400";
}

function tierLabel(source: string, score: number): string {
  if (source === "claude-code") return "Claude Code";
  if (source === "local") return "Local";
  if (score >= 90) return "Premium";
  if (score >= 70) return "Standard";
  return "Low-Cost";
}

function tierColor(source: string, score: number): string {
  if (source === "claude-code") return "text-purple-400";
  if (source === "local") return "text-emerald-400";
  if (score >= 90) return "text-amber-400";
  if (score >= 70) return "text-blue-400";
  return "text-green-400";
}

function tierBg(source: string, score: number): string {
  if (source === "claude-code") return "bg-purple-900/30 border-purple-800/50";
  if (source === "local") return "bg-emerald-900/30 border-emerald-800/50";
  if (score >= 90) return "bg-amber-900/30 border-amber-800/50";
  if (score >= 70) return "bg-blue-900/30 border-blue-800/50";
  return "bg-green-900/30 border-green-800/50";
}

// ── Grouping ─────────────────────────────────────────────────────────

type ModelGroup = { label: string; models: CatalogModel[] };

function groupModels(catalog: CatalogModel[]): ModelGroup[] {
  const claudeCode = catalog.filter((m) => m.source === "claude-code");
  const autoModel = catalog.filter((m) => m.id === "openrouter/auto");
  const premium = catalog.filter(
    (m) => m.source === "openrouter" && m.id !== "openrouter/auto" && m.codingScore >= 90
  );
  const standard = catalog.filter(
    (m) => m.source === "openrouter" && m.id !== "openrouter/auto" && m.codingScore >= 70 && m.codingScore < 90
  );
  const lowCost = catalog.filter(
    (m) => m.source === "openrouter" && m.id !== "openrouter/auto" && m.codingScore < 70
  );
  const local = catalog.filter((m) => m.source === "local");

  const groups: ModelGroup[] = [];
  if (claudeCode.length > 0) groups.push({ label: "Claude Code (Max Subscription)", models: claudeCode });
  if (autoModel.length > 0) groups.push({ label: "Auto", models: autoModel });
  if (premium.length > 0) groups.push({ label: "Premium Coding Models", models: premium });
  if (standard.length > 0) groups.push({ label: "Standard Coding Models", models: standard });
  if (lowCost.length > 0) groups.push({ label: "Low-Cost Coding Models", models: lowCost });
  if (local.length > 0) groups.push({ label: "Local (LM Studio \u2192 Claude Code CLI)", models: local });
  return groups;
}

// ── Component ────────────────────────────────────────────────────────

export default function ModelSelector({
  value,
  onChange,
  compact,
  allowInherit,
  persistKey,
}: {
  value: string;
  onChange: (id: string) => void;
  compact?: boolean;
  allowInherit?: boolean;
  persistKey?: string;
}) {
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [loading, setLoading] = useState(true);
  const initializedRef = useRef(false);

  // Load catalog + persisted selection on mount
  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    (async () => {
      const [models, lastSelection] = await Promise.all([
        getModelCatalog(),
        persistKey ? getLastModelSelection(persistKey) : Promise.resolve(null),
      ]);
      setCatalog(models);
      setLoading(false);

      // If parent hasn't set a meaningful value and we have a persisted selection, use it
      if (lastSelection && (!value || value === "openrouter/auto")) {
        // Verify the persisted model still exists in catalog
        if (models.some((m) => m.id === lastSelection)) {
          onChange(lastSelection);
        }
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Save selection when value changes (if persistKey provided)
  const handleChange = useCallback(
    (newValue: string) => {
      onChange(newValue);
      if (persistKey && newValue) {
        saveLastModelSelection(persistKey, newValue);
      }
    },
    [onChange, persistKey]
  );

  const groups = groupModels(catalog);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <div className="h-3 w-3 animate-spin rounded-full border-2 border-gray-600 border-t-gray-400" />
        Loading models...
      </div>
    );
  }

  // ── Compact mode: <select> with optgroups ────────────────────────

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {allowInherit && (
          <button
            onClick={() => handleChange("")}
            className={`px-2 py-1 text-xs rounded cursor-pointer ${
              value === ""
                ? "bg-gray-600 text-white"
                : "bg-gray-800 text-gray-400 hover:text-white border border-gray-700"
            }`}
          >
            Inherit
          </button>
        )}
        <select
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          disabled={allowInherit && value === ""}
          className="px-3 py-1.5 rounded-lg text-sm font-medium bg-gray-800 text-gray-300 border border-gray-700 focus:border-purple-500 focus:outline-none cursor-pointer disabled:opacity-50 min-w-[280px]"
        >
          {groups.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.source === "openrouter" && m.id !== "openrouter/auto"
                    ? ` (${formatCostShort(m.completionCostPerM)}/M out) \u2605 ${m.codingScore}`
                    : m.source === "local"
                      ? ` (Free) \u2605 ${m.codingScore}`
                      : ""}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
    );
  }

  // ── Full card mode ────────────────────────────────────────────────

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-300">Select Model</label>
        {allowInherit && (
          <button
            onClick={() => handleChange("")}
            className={`px-3 py-1.5 text-sm font-medium rounded-lg border cursor-pointer transition-colors ${
              value === ""
                ? "bg-gray-600 text-white border-gray-500"
                : "bg-gray-800 text-gray-400 hover:text-white border-gray-700"
            }`}
          >
            Inherit from Team
          </button>
        )}
      </div>

      {allowInherit && value === "" ? (
        <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4 text-sm text-gray-400">
          Model inherited from team default. Select a specific model to override.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-2">
                {group.label}
              </h4>
              <div className="grid gap-2">
                {group.models.map((m) => {
                  const isSelected = value === m.id;
                  const est = estimateCost(m, 3000, 8000);
                  const selectedBorderColor =
                    m.source === "local"
                      ? "border-emerald-500 bg-emerald-500/10"
                      : "border-purple-500 bg-purple-500/10";
                  const selectedTextColor =
                    m.source === "local" ? "text-emerald-400" : "text-purple-400";

                  return (
                    <button
                      key={m.id}
                      onClick={() => handleChange(m.id)}
                      className={`w-full text-left px-4 py-3 rounded-lg border text-sm transition-colors cursor-pointer ${
                        isSelected
                          ? selectedBorderColor
                          : "border-gray-700 bg-gray-800 hover:border-gray-600"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span
                            className={`font-semibold ${isSelected ? selectedTextColor : "text-gray-200"}`}
                          >
                            {m.name}
                          </span>
                          <span
                            className={`text-xs px-1.5 py-0.5 rounded border ${tierColor(m.source, m.codingScore)} ${tierBg(m.source, m.codingScore)}`}
                          >
                            {tierLabel(m.source, m.codingScore)}
                          </span>
                          <span className={`text-xs font-medium ${scoreBadgeColor(m.codingScore)}`}>
                            {"\u2605"} {m.codingScore}
                          </span>
                        </div>
                        <div className="text-right">
                          {m.source === "claude-code" ? (
                            <div className="text-xs text-gray-500">Max subscription</div>
                          ) : m.source === "local" ? (
                            <div className="text-xs text-emerald-600">Free</div>
                          ) : m.promptCostPerM !== null ? (
                            <div className="text-xs text-gray-500">
                              <span className="text-gray-400">{formatCost(m.promptCostPerM)}</span>{" "}
                              in /
                              <span className="text-gray-400">
                                {" "}
                                {formatCost(m.completionCostPerM)}
                              </span>{" "}
                              out
                            </div>
                          ) : (
                            <div className="text-xs text-gray-500">Cost varies</div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-1">
                        <span className="text-xs text-gray-500">
                          {m.description || `${(m.contextLength / 1000).toFixed(0)}K context`}
                        </span>
                        {m.source === "openrouter" && m.id !== "openrouter/auto" && (
                          <span className="text-xs text-gray-600">est. {est}/doc</span>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
