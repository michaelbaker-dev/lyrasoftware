"use client";

import { useState, useEffect, useCallback } from "react";
import type { OnboardingData } from "../onboarding-wizard";
import { getTeamRecommendation, saveTeamConfig } from "../actions";
import type { TemplateConfig, TemplateTeam } from "@/lib/team-templates";
import type { BreakdownAnalysis } from "@/lib/breakdown-analyzer";
import ModelSelector from "@/components/model-selector";

type LyraTeamStepProps = {
  data: OnboardingData;
  onNext: () => void;
  onBack?: () => void;
};

// ── Role badge colors ────────────────────────────────────────────────

const ROLE_COLORS: Record<string, string> = {
  dev: "bg-blue-900/50 text-blue-300 border-blue-800/50",
  qa: "bg-green-900/50 text-green-300 border-green-800/50",
  architect: "bg-purple-900/50 text-purple-300 border-purple-800/50",
  security: "bg-red-900/50 text-red-300 border-red-800/50",
  docs: "bg-yellow-900/50 text-yellow-300 border-yellow-800/50",
};

const SPEC_COLORS: Record<string, string> = {
  backend: "bg-orange-900/50 text-orange-300",
  frontend: "bg-cyan-900/50 text-cyan-300",
  qa: "bg-green-900/50 text-green-300",
  architecture: "bg-purple-900/50 text-purple-300",
  security: "bg-red-900/50 text-red-300",
  docs: "bg-yellow-900/50 text-yellow-300",
  triage: "bg-gray-700 text-gray-300",
  general: "bg-gray-700 text-gray-300",
};

function getRoleBadge(role: string) {
  return ROLE_COLORS[role] || "bg-gray-700 text-gray-300 border-gray-600";
}

function getSpecBadge(spec: string) {
  return SPEC_COLORS[spec] || "bg-gray-700 text-gray-300";
}

// ── Quick-switch template imports (inline to avoid server import issues) ──

const TEMPLATE_BUTTONS = [
  { name: "Minimal", desc: "2 teams, ~3 agents" },
  { name: "Backend Only", desc: "3 teams, ~4 agents" },
  { name: "Full Stack", desc: "5 teams, ~8 agents" },
];

// ── Component ────────────────────────────────────────────────────────

export default function LyraTeamStep({ data, onNext, onBack }: LyraTeamStepProps) {
  const [analysis, setAnalysis] = useState<BreakdownAnalysis | null>(null);
  const [config, setConfig] = useState<TemplateConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedTeam, setExpandedTeam] = useState<number | null>(null);

  // Load analysis + recommended config on mount
  useEffect(() => {
    (async () => {
      const result = await getTeamRecommendation(data.jiraKey);
      if (result.success && result.analysis) {
        setAnalysis(result.analysis);
        setConfig(result.analysis.recommendedConfig);
      } else {
        // No breakdown — use minimal template as default
        const { MINIMAL_TEMPLATE } = await import("@/lib/team-templates");
        setConfig(JSON.parse(JSON.stringify(MINIMAL_TEMPLATE)));
      }
      setLoading(false);
    })();
  }, [data.jiraKey]);

  // Quick-switch to a template
  const switchTemplate = useCallback(async (templateName: string) => {
    const templates = await import("@/lib/team-templates");
    let tmpl: TemplateConfig;
    if (templateName === "Full Stack") tmpl = templates.FULL_STACK_TEMPLATE;
    else if (templateName === "Backend Only") tmpl = templates.BACKEND_ONLY_TEMPLATE;
    else tmpl = templates.MINIMAL_TEMPLATE;
    setConfig(JSON.parse(JSON.stringify(tmpl)));
  }, []);

  // Update a team field
  const updateTeam = useCallback((index: number, updates: Partial<TemplateTeam>) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const teams = [...prev.teams];
      teams[index] = { ...teams[index], ...updates };
      return { ...prev, teams };
    });
  }, []);

  // Add/remove agents
  const adjustAgentCount = useCallback((teamIndex: number, delta: number) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const teams = [...prev.teams];
      const team = { ...teams[teamIndex] };
      const agents = [...team.agents];

      if (delta > 0 && agents.length < team.maxAgents) {
        const template = agents[agents.length - 1] || { role: "dev", personality: "General purpose developer." };
        agents.push({ ...template });
      } else if (delta < 0 && agents.length > 1) {
        agents.pop();
      }

      team.agents = agents;
      teams[teamIndex] = team;
      return { ...prev, teams };
    });
  }, []);

  // Toggle team enabled (remove/restore)
  const removeTeam = useCallback((index: number) => {
    setConfig((prev) => {
      if (!prev || prev.teams.length <= 1) return prev;
      const teams = prev.teams.filter((_, i) => i !== index);
      return { ...prev, teams };
    });
    setExpandedTeam(null);
  }, []);

  // Add a blank team
  const addTeam = useCallback(() => {
    setConfig((prev) => {
      if (!prev) return prev;
      const newTeam: TemplateTeam = {
        name: "New Team",
        specialization: "general",
        model: "claude-code/sonnet",
        routingLabels: [],
        routingPriority: 50,
        isDefault: false,
        maxAgents: 4,
        systemPrompt: "You are a development team agent. Follow the project CLAUDE.md for conventions.",
        agents: [{ role: "dev", personality: "General purpose developer." }],
      };
      return { ...prev, teams: [...prev.teams, newTeam] };
    });
  }, []);

  // Save and proceed
  const handleNext = useCallback(async () => {
    if (!config) return;
    setSaving(true);
    setError(null);
    const result = await saveTeamConfig(data.jiraKey, config);
    setSaving(false);
    if (result.success) {
      onNext();
    } else {
      setError(result.error || "Failed to save team config");
    }
  }, [config, data.jiraKey, onNext]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-gray-600 border-t-blue-500" />
        <span className="ml-3 text-gray-400">Analyzing breakdown...</span>
      </div>
    );
  }

  const totalAgents = config?.teams.reduce((sum, t) => sum + t.agents.length, 0) || 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">Team Setup</h2>
        <p className="text-gray-400">
          {analysis
            ? "Team configuration recommended from your work breakdown. Customize as needed."
            : "Configure your AI agent teams. No breakdown available — using default template."}
        </p>
      </div>

      {/* Analysis Summary */}
      {analysis && (
        <div className="bg-gray-800 rounded-lg p-5 space-y-3">
          <h3 className="text-sm font-semibold text-gray-300">
            Breakdown Analysis ({analysis.totalStories} stories, {analysis.totalPoints} points)
          </h3>

          {/* Role distribution */}
          <div className="flex flex-wrap gap-2">
            {Object.entries(analysis.roleCounts).map(([role, counts]) => (
              <span
                key={role}
                className={`text-xs px-2 py-1 rounded-full border ${getRoleBadge(role)}`}
              >
                {role}: {counts.stories} stories ({counts.points} pts)
              </span>
            ))}
          </div>

          {/* Detected needs */}
          <div className="flex flex-wrap gap-3 text-xs text-gray-400">
            {analysis.needsFrontend && (
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Frontend
              </span>
            )}
            {analysis.needsBackend && (
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Backend
              </span>
            )}
            {analysis.needsArchitecture && (
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Architecture
              </span>
            )}
            {analysis.needsSecurity && (
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Security
              </span>
            )}
            {analysis.needsDocs && (
              <span className="flex items-center gap-1">
                <svg className="w-3.5 h-3.5 text-green-400" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Docs
              </span>
            )}
          </div>

          <p className="text-xs text-gray-500">
            Recommended baseline: <span className="text-gray-300 font-medium">{analysis.recommendedTemplateName}</span>
          </p>
        </div>
      )}

      {/* Template Quick-Switch */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 mr-1">Quick switch:</span>
        {TEMPLATE_BUTTONS.map((tb) => (
          <button
            key={tb.name}
            onClick={() => switchTemplate(tb.name)}
            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-500 hover:text-white transition-colors cursor-pointer"
            title={tb.desc}
          >
            {tb.name}
          </button>
        ))}
      </div>

      {/* Team Configuration */}
      {config && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-300">
              Teams ({config.teams.length}) &middot; Agents ({totalAgents})
            </h3>
          </div>

          {config.teams.map((team, ti) => {
            const isExpanded = expandedTeam === ti;
            return (
              <div key={ti} className="bg-gray-800 rounded-lg border border-gray-700">
                {/* Team header */}
                <div className="flex items-center gap-3 px-4 py-3">
                  <button
                    onClick={() => setExpandedTeam(isExpanded ? null : ti)}
                    className="flex items-center gap-2 flex-1 text-left cursor-pointer"
                  >
                    <svg
                      className={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                      fill="currentColor"
                      viewBox="0 0 20 20"
                    >
                      <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                    </svg>
                    <span className="font-medium text-gray-100">{team.name}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${getSpecBadge(team.specialization)}`}>
                      {team.specialization}
                    </span>
                  </button>

                  {/* Agent count controls */}
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => adjustAgentCount(ti, -1)}
                      disabled={team.agents.length <= 1}
                      className="w-6 h-6 flex items-center justify-center rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-sm cursor-pointer"
                    >
                      -
                    </button>
                    <span className="text-sm text-gray-300 w-8 text-center">
                      {team.agents.length}
                    </span>
                    <button
                      onClick={() => adjustAgentCount(ti, 1)}
                      disabled={team.agents.length >= team.maxAgents}
                      className="w-6 h-6 flex items-center justify-center rounded bg-gray-700 text-gray-300 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed text-sm cursor-pointer"
                    >
                      +
                    </button>
                    <span className="text-xs text-gray-600 ml-1">agents</span>
                  </div>

                  {/* Model selector (compact) */}
                  <div className="hidden sm:block">
                    <ModelSelector
                      value={team.model}
                      onChange={(model) => updateTeam(ti, { model })}
                      compact
                    />
                  </div>

                  {/* Remove */}
                  {config.teams.length > 1 && (
                    <button
                      onClick={() => removeTeam(ti)}
                      className="text-gray-600 hover:text-red-400 transition-colors cursor-pointer"
                      title="Remove team"
                    >
                      <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
                      </svg>
                    </button>
                  )}
                </div>

                {/* Expanded: agent details + routing */}
                {isExpanded && (
                  <div className="border-t border-gray-700 px-4 py-3 space-y-3">
                    {/* Mobile model selector */}
                    <div className="sm:hidden">
                      <ModelSelector
                        value={team.model}
                        onChange={(model) => updateTeam(ti, { model })}
                        compact
                      />
                    </div>

                    {/* Agents */}
                    <div className="space-y-2">
                      <span className="text-xs text-gray-500 font-medium">Agents:</span>
                      {team.agents.map((agent, ai) => (
                        <div key={ai} className="flex items-center gap-2 text-sm pl-2">
                          <span className={`text-xs px-1.5 py-0.5 rounded border ${getRoleBadge(agent.role)}`}>
                            {agent.role}
                          </span>
                          <span className="text-gray-400 text-xs truncate">
                            {agent.personality}
                          </span>
                        </div>
                      ))}
                    </div>

                    {/* Routing labels */}
                    {team.routingLabels.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        <span className="text-xs text-gray-500 mr-1">Routes:</span>
                        {team.routingLabels.map((label) => (
                          <span
                            key={label}
                            className="text-xs px-1.5 py-0.5 rounded bg-gray-700 text-gray-400"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    )}

                    {/* Default team indicator */}
                    {team.isDefault && (
                      <p className="text-xs text-gray-500">
                        Default team — receives unrouted tickets
                      </p>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {/* Add team button */}
          <button
            onClick={addTeam}
            className="w-full py-2 border border-dashed border-gray-700 rounded-lg text-sm text-gray-500 hover:text-gray-300 hover:border-gray-500 transition-colors cursor-pointer"
          >
            + Add Team
          </button>
        </div>
      )}

      {/* Lyra Services (always shown) */}
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-semibold text-gray-300 mb-2">Lyra Services:</h3>
        <div className="space-y-1.5">
          {[
            { name: "Dispatcher", interval: "Every 15 min", desc: "Polls Jira for To Do tickets, spawns dev agents" },
            { name: "QA Runner", interval: "Every 15 min", desc: "Polls for Code Review tickets, spawns QA agents" },
            { name: "Quality Gate", interval: "On agent completion", desc: "Validates work before PR creation" },
            { name: "Lyra Brain", interval: "On events", desc: "AI decisions for approvals, escalations, retries" },
          ].map((s) => (
            <div key={s.name} className="flex items-start gap-3 text-sm">
              <span className="text-gray-300 font-medium w-28 shrink-0">{s.name}</span>
              <span className="text-gray-500 text-xs w-32 shrink-0">{s.interval}</span>
              <span className="text-gray-400 text-xs">{s.desc}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="rounded-lg border border-red-800/50 bg-red-900/20 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        {onBack && (
          <button
            onClick={onBack}
            className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors"
          >
            Back
          </button>
        )}
        <button
          onClick={handleNext}
          disabled={saving || !config}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors ml-auto"
        >
          {saving ? "Saving..." : "Next"}
        </button>
      </div>
    </div>
  );
}
