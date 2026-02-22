"use client";

import { useState, useTransition, useEffect } from "react";
import {
  updateTeam,
  deleteTeam,
  addTeam,
  updateAgent,
  addAgentToTeam,
  removeAgent,
  applyTemplateAction,
  getAvailableTemplates,
  getAvailableRoles,
  analyzeRebalanceAction,
  executeRebalanceAction,
  validateTeamAction,
  applySavedTeamConfig,
  fixRoleGap,
  type ValidationResult,
} from "./team-actions";
import ModelSelector from "@/components/model-selector";
import type { RebalancePlan } from "@/lib/team-rebalancer";

// ── Types ────────────────────────────────────────────────────────────

type AgentData = {
  id: string;
  name: string;
  role: string;
  model: string | null;
  personality: string | null;
  status: string;
  currentTicket: string | null;
};

type TeamData = {
  id: string;
  name: string;
  specialization: string;
  model: string;
  systemPrompt: string | null;
  routingLabels: string | null;
  routingPriority: number;
  isDefault: boolean;
  enabled: boolean;
  maxAgents: number;
  agents: AgentData[];
};

type TemplateInfo = {
  name: string;
  description: string;
  isBuiltIn: boolean;
};

const SPECIALIZATIONS = [
  "general",
  "backend",
  "frontend",
  "infra",
  "qa",
  "triage",
  "architecture",
  "security",
  "devops",
  "monitoring",
  "performance",
  "documentation",
];

const DEFAULT_ROLES = ["dev", "qa", "architect"];

const specColor: Record<string, string> = {
  backend: "bg-blue-900/30 text-blue-400 border-blue-800/50",
  frontend: "bg-purple-900/30 text-purple-400 border-purple-800/50",
  qa: "bg-yellow-900/30 text-yellow-400 border-yellow-800/50",
  architecture: "bg-amber-900/30 text-amber-400 border-amber-800/50",
  triage: "bg-gray-800/50 text-gray-400 border-gray-700",
  infra: "bg-cyan-900/30 text-cyan-400 border-cyan-800/50",
  general: "bg-gray-800/50 text-gray-300 border-gray-700",
  security: "bg-red-900/30 text-red-400 border-red-800/50",
  devops: "bg-orange-900/30 text-orange-400 border-orange-800/50",
  monitoring: "bg-teal-900/30 text-teal-400 border-teal-800/50",
  performance: "bg-emerald-900/30 text-emerald-400 border-emerald-800/50",
  documentation: "bg-indigo-900/30 text-indigo-400 border-indigo-800/50",
};

const agentStatusColor: Record<string, string> = {
  idle: "text-gray-500",
  running: "text-green-400",
  errored: "text-red-400",
  "rate-limited": "text-yellow-400",
};

// ── Main Component ───────────────────────────────────────────────────

export default function TeamConfig({
  projectId,
  teams: initialTeams,
}: {
  projectId: string;
  teams: TeamData[];
}) {
  const [teams, setTeams] = useState(initialTeams);
  const [expandedTeam, setExpandedTeam] = useState<string | null>(null);
  const [editingPrompt, setEditingPrompt] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [showAddTeam, setShowAddTeam] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Dynamic roles from DB
  const [roles, setRoles] = useState<string[]>(DEFAULT_ROLES);
  useEffect(() => {
    getAvailableRoles().then((r) => setRoles(r.map((x) => x.role)));
  }, []);

  // Rebalance state
  const [showRebalanceBanner, setShowRebalanceBanner] = useState(false);
  const [rebalancePlan, setRebalancePlan] = useState<RebalancePlan | null>(null);
  const [rebalanceLoading, setRebalanceLoading] = useState(false);
  const [rebalanceError, setRebalanceError] = useState<string | null>(null);
  const [selectedTickets, setSelectedTickets] = useState<Set<string>>(new Set());
  const [selectedStories, setSelectedStories] = useState<Set<number>>(new Set());
  const [rebalanceSuccess, setRebalanceSuccess] = useState<string | null>(null);
  const [rebalanceModel, setRebalanceModel] = useState("openrouter/auto");
  const [showRebalanceConfig, setShowRebalanceConfig] = useState(false);

  // Validate state
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [validationLoading, setValidationLoading] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [fixingRole, setFixingRole] = useState<string | null>(null);
  const [applyingConfig, setApplyingConfig] = useState(false);

  // ── Rebalance actions ──────────────────────────────────────────────

  const triggerRebalanceBanner = () => {
    setShowRebalanceBanner(true);
    setRebalancePlan(null);
    setRebalanceError(null);
    setRebalanceSuccess(null);
  };

  const handleAnalyzeRebalance = async () => {
    setRebalanceLoading(true);
    setRebalanceError(null);
    setRebalancePlan(null);
    setRebalanceSuccess(null);
    try {
      const res = await analyzeRebalanceAction(projectId, rebalanceModel);
      if (res.success && res.plan) {
        setRebalancePlan(res.plan);
        // Pre-select all reassignments and stories
        setSelectedTickets(new Set(res.plan.reassignments.map((r) => r.ticketKey)));
        setSelectedStories(new Set(res.plan.newStories.map((_, i) => i)));
      } else {
        setRebalanceError(res.error || "Analysis failed");
      }
    } catch (e) {
      setRebalanceError((e as Error).message);
    } finally {
      setRebalanceLoading(false);
    }
  };

  const handleExecuteRebalance = async () => {
    if (!rebalancePlan) return;
    setRebalanceLoading(true);
    setRebalanceError(null);
    try {
      const res = await executeRebalanceAction(
        projectId,
        rebalancePlan,
        Array.from(selectedTickets),
        Array.from(selectedStories)
      );
      if (res.success && res.result) {
        const r = res.result;
        const parts: string[] = [];
        if (r.labelsUpdated > 0) parts.push(`${r.labelsUpdated} ticket(s) updated`);
        if (r.storiesCreated.length > 0) parts.push(`${r.storiesCreated.length} story/stories created (${r.storiesCreated.join(", ")})`);
        if (r.errors.length > 0) parts.push(`${r.errors.length} error(s)`);
        setRebalanceSuccess(parts.join(", ") || "Rebalance complete");
        setRebalancePlan(null);
        setShowRebalanceBanner(false);
      } else {
        setRebalanceError(res.error || "Execution failed");
      }
    } catch (e) {
      setRebalanceError((e as Error).message);
    } finally {
      setRebalanceLoading(false);
    }
  };

  const toggleTicket = (key: string) => {
    setSelectedTickets((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleStory = (idx: number) => {
    setSelectedStories((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  // ── Validate actions ─────────────────────────────────────────────

  const handleValidateTeam = async () => {
    setValidationLoading(true);
    setValidationError(null);
    setValidationResult(null);
    try {
      const res = await validateTeamAction(projectId);
      if (res.success && res.result) {
        setValidationResult(res.result);
      } else {
        setValidationError(res.error || "Validation failed");
      }
    } catch (e) {
      setValidationError((e as Error).message);
    } finally {
      setValidationLoading(false);
    }
  };

  const handleApplySavedConfig = async () => {
    setApplyingConfig(true);
    try {
      const res = await applySavedTeamConfig(projectId);
      if (res.success) {
        window.location.reload();
      } else {
        setValidationError(res.error || "Failed to apply config");
      }
    } catch (e) {
      setValidationError((e as Error).message);
    } finally {
      setApplyingConfig(false);
    }
  };

  const handleFixGap = async (role: string) => {
    setFixingRole(role);
    try {
      const res = await fixRoleGap(projectId, role);
      if (res.success) {
        window.location.reload();
      } else {
        setValidationError(res.error || `Failed to add ${role} agent`);
      }
    } catch (e) {
      setValidationError((e as Error).message);
    } finally {
      setFixingRole(null);
    }
  };

  // ── Template actions ──────────────────────────────────────────────

  const handleShowTemplates = async () => {
    const tpls = await getAvailableTemplates();
    setTemplates(tpls);
    setShowTemplateDialog(true);
  };

  const handleApplyTemplate = (name: string) => {
    if (!confirm(`This will replace all current teams and agents with the "${name}" template. Continue?`)) {
      return;
    }
    startTransition(async () => {
      await applyTemplateAction(projectId, name);
      setShowTemplateDialog(false);
      triggerRebalanceBanner();
      // Force page refresh to get updated data
      window.location.reload();
    });
  };

  // ── Team actions ──────────────────────────────────────────────────

  const handleUpdateTeam = (teamId: string, field: string, value: unknown) => {
    setTeams((prev) =>
      prev.map((t) => (t.id === teamId ? { ...t, [field]: value } : t))
    );
    startTransition(async () => {
      await updateTeam(teamId, { [field]: value });
    });
  };

  const handleDeleteTeam = (teamId: string, teamName: string) => {
    if (!confirm(`Delete team "${teamName}" and unassign all its agents?`)) return;
    startTransition(async () => {
      await deleteTeam(teamId);
      setTeams((prev) => prev.filter((t) => t.id !== teamId));
      triggerRebalanceBanner();
    });
  };

  const handleAddTeam = (data: { name: string; specialization: string; model: string }) => {
    startTransition(async () => {
      const result = await addTeam(projectId, data);
      if (result.success && result.teamId) {
        setTeams((prev) => [
          ...prev,
          {
            id: result.teamId!,
            name: data.name,
            specialization: data.specialization,
            model: data.model,
            systemPrompt: null,
            routingLabels: null,
            routingPriority: 50,
            isDefault: false,
            enabled: true,
            maxAgents: 4,
            agents: [],
          },
        ]);
        setShowAddTeam(false);
        triggerRebalanceBanner();
      }
    });
  };

  const handleSetDefault = (teamId: string) => {
    setTeams((prev) =>
      prev.map((t) => ({ ...t, isDefault: t.id === teamId }))
    );
    startTransition(async () => {
      await updateTeam(teamId, { isDefault: true });
    });
  };

  // ── Agent actions ─────────────────────────────────────────────────

  const handleUpdateAgent = (agentId: string, field: string, value: unknown) => {
    setTeams((prev) =>
      prev.map((t) => ({
        ...t,
        agents: t.agents.map((a) =>
          a.id === agentId ? { ...a, [field]: value } : a
        ),
      }))
    );
    startTransition(async () => {
      await updateAgent(agentId, { [field]: value });
    });
  };

  const handleAddAgent = (teamId: string, role: string) => {
    startTransition(async () => {
      const result = await addAgentToTeam(teamId, { role });
      if (result.success) {
        window.location.reload();
      }
    });
  };

  const handleRemoveAgent = (agentId: string, agentName: string) => {
    if (!confirm(`Remove agent "${agentName}"?`)) return;
    startTransition(async () => {
      const result = await removeAgent(agentId);
      if (result.success) {
        setTeams((prev) =>
          prev.map((t) => ({
            ...t,
            agents: t.agents.filter((a) => a.id !== agentId),
          }))
        );
      }
    });
  };

  // ── Routing labels helper ─────────────────────────────────────────

  const parseLabels = (json: string | null): string[] => {
    if (!json) return [];
    try { return JSON.parse(json); } catch { return []; }
  };

  const handleLabelChange = (teamId: string, labels: string[]) => {
    const json = JSON.stringify(labels);
    handleUpdateTeam(teamId, "routingLabels", json);
  };

  // ── Render ────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Team Configuration</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleValidateTeam}
            disabled={validationLoading}
            className="px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {validationLoading ? "Validating..." : "Validate Team"}
          </button>
          <button
            onClick={() => setShowRebalanceConfig((v) => !v)}
            disabled={rebalanceLoading || teams.length === 0}
            className="px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {rebalanceLoading ? "Analyzing..." : "Rebalance Work"}
          </button>
          <button
            onClick={handleShowTemplates}
            className="px-3 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg transition-colors cursor-pointer"
          >
            Apply Template
          </button>
          <button
            onClick={() => setShowAddTeam(true)}
            className="px-3 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition-colors cursor-pointer"
          >
            + Add Team
          </button>
        </div>
      </div>

      {/* Template Dialog */}
      {showTemplateDialog && (
        <div className="rounded-xl border border-purple-800/50 bg-purple-900/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-medium text-purple-300">Select Team Template</h3>
            <button
              onClick={() => setShowTemplateDialog(false)}
              className="text-gray-500 hover:text-gray-300 cursor-pointer"
            >
              Cancel
            </button>
          </div>
          <div className="grid gap-2">
            {templates.map((tpl) => (
              <button
                key={tpl.name}
                onClick={() => handleApplyTemplate(tpl.name)}
                disabled={isPending}
                className="w-full text-left px-4 py-3 rounded-lg border border-gray-700 bg-gray-800 hover:border-purple-600 transition-colors cursor-pointer disabled:opacity-50"
              >
                <div className="font-medium text-gray-200">{tpl.name}</div>
                <div className="text-xs text-gray-500 mt-1">{tpl.description}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Validation Results */}
      {validationResult && (
        <ValidationPanel
          result={validationResult}
          onFixGap={handleFixGap}
          onApplySavedConfig={handleApplySavedConfig}
          onDismiss={() => setValidationResult(null)}
          fixingRole={fixingRole}
          applyingConfig={applyingConfig}
        />
      )}

      {/* Validation Error */}
      {validationError && !validationResult && (
        <div className="rounded-xl border border-red-800/50 bg-red-900/10 p-4 flex items-center justify-between">
          <span className="text-sm text-red-300">{validationError}</span>
          <div className="flex gap-2">
            <button
              onClick={handleValidateTeam}
              className="text-sm text-green-400 hover:text-green-300 cursor-pointer"
            >
              Retry
            </button>
            <button
              onClick={() => setValidationError(null)}
              className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Add Team Form */}
      {showAddTeam && (
        <AddTeamForm
          onAdd={handleAddTeam}
          onCancel={() => setShowAddTeam(false)}
        />
      )}

      {/* Rebalance Success Toast */}
      {rebalanceSuccess && (
        <div className="rounded-xl border border-green-800/50 bg-green-900/10 p-4 flex items-center justify-between">
          <span className="text-sm text-green-300">{rebalanceSuccess}</span>
          <button
            onClick={() => setRebalanceSuccess(null)}
            className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Rebalance Error */}
      {rebalanceError && (
        <div className="rounded-xl border border-red-800/50 bg-red-900/10 p-4 flex items-center justify-between">
          <span className="text-sm text-red-300">{rebalanceError}</span>
          <div className="flex gap-2">
            <button
              onClick={handleAnalyzeRebalance}
              className="text-sm text-amber-400 hover:text-amber-300 cursor-pointer"
            >
              Retry
            </button>
            <button
              onClick={() => setRebalanceError(null)}
              className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Rebalance Config (from header button) */}
      {showRebalanceConfig && !showRebalanceBanner && !rebalancePlan && !rebalanceLoading && (
        <div className="rounded-xl border border-amber-800/50 bg-amber-900/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-amber-300">Rebalance Project Work</h3>
            <button
              onClick={() => setShowRebalanceConfig(false)}
              className="text-sm text-gray-500 hover:text-gray-300 cursor-pointer"
            >
              Cancel
            </button>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 shrink-0">Model:</label>
            <ModelSelector
              value={rebalanceModel}
              onChange={setRebalanceModel}
              compact
              persistKey="rebalance"
            />
            <button
              onClick={() => { setShowRebalanceConfig(false); handleAnalyzeRebalance(); }}
              className="px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg cursor-pointer shrink-0"
            >
              Analyze
            </button>
          </div>
        </div>
      )}

      {/* Post-change Rebalance Banner */}
      {showRebalanceBanner && !rebalancePlan && !rebalanceLoading && (
        <div className="rounded-xl border border-amber-800/50 bg-amber-900/10 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm text-amber-300">
              Team structure changed — rebalance project work?
            </span>
            <button
              onClick={() => setShowRebalanceBanner(false)}
              className="text-sm text-gray-500 hover:text-gray-300 cursor-pointer"
            >
              Skip
            </button>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 shrink-0">Model:</label>
            <ModelSelector
              value={rebalanceModel}
              onChange={setRebalanceModel}
              compact
              persistKey="rebalance"
            />
            <button
              onClick={handleAnalyzeRebalance}
              className="px-3 py-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg cursor-pointer shrink-0"
            >
              Rebalance Now
            </button>
          </div>
        </div>
      )}

      {/* Rebalance Loading */}
      {rebalanceLoading && (
        <div className="rounded-xl border border-amber-800/50 bg-amber-900/10 p-4 text-center">
          <div className="text-sm text-amber-300 animate-pulse">
            Analyzing sprint tickets against {teams.length} team(s)...
          </div>
        </div>
      )}

      {/* Rebalance Preview Panel */}
      {rebalancePlan && (
        <RebalancePreview
          plan={rebalancePlan}
          selectedTickets={selectedTickets}
          selectedStories={selectedStories}
          onToggleTicket={toggleTicket}
          onToggleStory={toggleStory}
          onApply={handleExecuteRebalance}
          onDismiss={() => { setRebalancePlan(null); setShowRebalanceBanner(false); }}
          loading={rebalanceLoading}
        />
      )}

      {/* Team Cards */}
      {teams.length === 0 ? (
        <p className="text-sm text-gray-500">No teams configured. Apply a template or add teams manually.</p>
      ) : (
        <div className="space-y-3">
          {teams.map((team) => {
            const isExpanded = expandedTeam === team.id;
            const labels = parseLabels(team.routingLabels);

            return (
              <div
                key={team.id}
                className={`rounded-xl border bg-gray-900 p-4 transition-colors ${
                  team.enabled ? "border-gray-800" : "border-gray-800/50 opacity-60"
                }`}
              >
                {/* Team Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => setExpandedTeam(isExpanded ? null : team.id)}
                      className="text-gray-400 hover:text-white cursor-pointer"
                    >
                      {isExpanded ? "\u25BC" : "\u25B6"}
                    </button>
                    <h3 className="font-semibold text-gray-200">{team.name}</h3>
                    <span className={`text-xs px-2 py-0.5 rounded border ${specColor[team.specialization] || specColor.general}`}>
                      {team.specialization}
                    </span>
                    <span className="text-xs text-gray-500">{team.model}</span>
                    {team.isDefault && (
                      <span className="text-xs px-2 py-0.5 rounded bg-green-900/30 text-green-400 border border-green-800/50">
                        Default
                      </span>
                    )}
                    <span className="text-xs text-gray-600">
                      {team.agents.length}/{team.maxAgents} agents
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1 text-xs text-gray-500">
                      <input
                        type="checkbox"
                        checked={team.enabled}
                        onChange={(e) => handleUpdateTeam(team.id, "enabled", e.target.checked)}
                        className="cursor-pointer"
                      />
                      Enabled
                    </label>
                    {!team.isDefault && (
                      <button
                        onClick={() => handleSetDefault(team.id)}
                        className="text-xs text-gray-500 hover:text-green-400 cursor-pointer"
                        title="Set as default team"
                      >
                        Set Default
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteTeam(team.id, team.name)}
                      className="text-xs text-red-500/50 hover:text-red-400 cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>

                {/* Routing Labels */}
                {labels.length > 0 && (
                  <div className="flex gap-1.5 mt-2 ml-8">
                    {labels.map((label) => (
                      <span
                        key={label}
                        className="text-xs px-2 py-0.5 rounded-full bg-gray-800 text-gray-400 border border-gray-700"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}

                {/* Expanded: Team Details + Agents */}
                {isExpanded && (
                  <div className="mt-4 ml-8 space-y-4">
                    {/* Team Settings */}
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Name</label>
                        <input
                          value={team.name}
                          onChange={(e) => handleUpdateTeam(team.id, "name", e.target.value)}
                          className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Specialization</label>
                        <SpecializationSelector
                          value={team.specialization}
                          onChange={(val) => handleUpdateTeam(team.id, "specialization", val)}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Max Agents</label>
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={team.maxAgents}
                          onChange={(e) => handleUpdateTeam(team.id, "maxAgents", parseInt(e.target.value) || 4)}
                          className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-purple-500"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Routing Priority</label>
                        <input
                          type="number"
                          min={1}
                          max={100}
                          value={team.routingPriority}
                          onChange={(e) => handleUpdateTeam(team.id, "routingPriority", parseInt(e.target.value) || 50)}
                          className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-purple-500"
                        />
                      </div>
                    </div>

                    {/* Model Selector */}
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">Team Model</label>
                      <ModelSelector
                        value={team.model}
                        onChange={(model) => handleUpdateTeam(team.id, "model", model)}
                        compact
                      />
                    </div>

                    {/* Routing Labels Editor */}
                    <RoutingLabelsInput
                      labels={labels}
                      onChange={(newLabels) => handleLabelChange(team.id, newLabels)}
                    />

                    {/* System Prompt */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs text-gray-500">System Prompt</label>
                        <button
                          onClick={() => setEditingPrompt(editingPrompt === team.id ? null : team.id)}
                          className="text-xs text-gray-500 hover:text-gray-300 cursor-pointer"
                        >
                          {editingPrompt === team.id ? "Collapse" : "Edit"}
                        </button>
                      </div>
                      {editingPrompt === team.id ? (
                        <textarea
                          value={team.systemPrompt || ""}
                          onChange={(e) => handleUpdateTeam(team.id, "systemPrompt", e.target.value || null)}
                          rows={6}
                          className="w-full px-3 py-2 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 font-mono focus:outline-none focus:border-purple-500 resize-y"
                        />
                      ) : (
                        <p className="text-xs text-gray-500 truncate">
                          {team.systemPrompt?.slice(0, 120) || "No system prompt set"}
                          {team.systemPrompt && team.systemPrompt.length > 120 ? "..." : ""}
                        </p>
                      )}
                    </div>

                    {/* Agents List */}
                    <div>
                      <div className="flex items-center justify-between mb-2">
                        <label className="text-sm font-medium text-gray-400">Agents</label>
                        <div className="flex gap-1">
                          {roles.map((role) => (
                            <button
                              key={role}
                              onClick={() => handleAddAgent(team.id, role)}
                              disabled={team.agents.length >= team.maxAgents}
                              className="px-2 py-1 text-xs bg-gray-800 hover:bg-gray-700 text-gray-400 rounded border border-gray-700 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              + {role}
                            </button>
                          ))}
                        </div>
                      </div>

                      {team.agents.length === 0 ? (
                        <p className="text-xs text-gray-600">No agents in this team.</p>
                      ) : (
                        <div className="space-y-2">
                          {team.agents.map((agent) => (
                            <div
                              key={agent.id}
                              className="flex items-start justify-between rounded-lg bg-gray-800 p-3 text-sm"
                            >
                              <div className="flex-1 space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium text-gray-200">{agent.name}</span>
                                  <span className="text-xs capitalize text-gray-500">{agent.role}</span>
                                  <span className={`text-xs ${agentStatusColor[agent.status] || "text-gray-400"}`}>
                                    {agent.status}
                                  </span>
                                  {agent.currentTicket && (
                                    <span className="text-xs text-blue-400">{agent.currentTicket}</span>
                                  )}
                                  <span className="text-xs text-gray-600">
                                    {agent.model || "inherit"}
                                  </span>
                                </div>
                                <input
                                  value={agent.personality || ""}
                                  onChange={(e) => handleUpdateAgent(agent.id, "personality", e.target.value || null)}
                                  placeholder="Agent personality..."
                                  className="w-full px-2 py-1 text-xs bg-gray-900 border border-gray-700 rounded text-gray-400 focus:outline-none focus:border-purple-500"
                                />
                              </div>
                              <button
                                onClick={() => handleRemoveAgent(agent.id, agent.name)}
                                disabled={agent.status === "running"}
                                className="ml-2 text-xs text-red-500/50 hover:text-red-400 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                              >
                                Remove
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Rebalance Preview ─────────────────────────────────────────────────

function RebalancePreview({
  plan,
  selectedTickets,
  selectedStories,
  onToggleTicket,
  onToggleStory,
  onApply,
  onDismiss,
  loading,
}: {
  plan: RebalancePlan;
  selectedTickets: Set<string>;
  selectedStories: Set<number>;
  onToggleTicket: (key: string) => void;
  onToggleStory: (idx: number) => void;
  onApply: () => void;
  onDismiss: () => void;
  loading: boolean;
}) {
  const totalAnalyzed =
    plan.reassignments.length + plan.unchanged.length + plan.skippedInProgress.length;
  const hasSelections = selectedTickets.size > 0 || selectedStories.size > 0;

  return (
    <div className="rounded-xl border border-amber-800/50 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-amber-300">Rebalance Preview</h3>
        <button
          onClick={onDismiss}
          className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm"
        >
          Dismiss
        </button>
      </div>

      {/* Summary stats */}
      <div className="flex gap-4 text-xs text-gray-400">
        <span>{totalAnalyzed} ticket(s) analyzed</span>
        <span>{plan.reassignments.length} reassignment(s)</span>
        <span>{plan.newStories.length} new story suggestion(s)</span>
        <span>{plan.skippedInProgress.length} skipped (in-progress)</span>
      </div>

      {/* Warnings */}
      {plan.warnings.length > 0 && (
        <div className="space-y-1">
          {plan.warnings.map((w, i) => (
            <p key={i} className="text-xs text-yellow-500">{w}</p>
          ))}
        </div>
      )}

      {/* Reassignments table */}
      {plan.reassignments.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">Reassignments</h4>
          <div className="space-y-1">
            {plan.reassignments.map((r) => (
              <label
                key={r.ticketKey}
                className="flex items-start gap-3 rounded-lg bg-gray-800 p-3 text-sm cursor-pointer hover:bg-gray-750"
              >
                <input
                  type="checkbox"
                  checked={selectedTickets.has(r.ticketKey)}
                  onChange={() => onToggleTicket(r.ticketKey)}
                  className="mt-0.5 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-blue-400 text-xs">{r.ticketKey}</span>
                    <span className="text-gray-300 truncate">{r.summary}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    <span className="text-gray-500">{r.currentTeam || "Unassigned"}</span>
                    <span className="text-gray-600">&rarr;</span>
                    <span className="text-amber-400">{r.recommendedTeam}</span>
                    <span className="text-gray-600">|</span>
                    <span className={r.confidence >= 0.8 ? "text-green-400" : r.confidence >= 0.5 ? "text-yellow-400" : "text-red-400"}>
                      {Math.round(r.confidence * 100)}%
                    </span>
                    {r.addLabels.length > 0 && (
                      <>
                        <span className="text-gray-600">|</span>
                        <span className="text-gray-500">+{r.addLabels.join(", +")}</span>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{r.reasoning}</p>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* New Stories */}
      {plan.newStories.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">Suggested New Stories</h4>
          <div className="space-y-1">
            {plan.newStories.map((s, idx) => (
              <label
                key={idx}
                className="flex items-start gap-3 rounded-lg bg-gray-800 p-3 text-sm cursor-pointer hover:bg-gray-750"
              >
                <input
                  type="checkbox"
                  checked={selectedStories.has(idx)}
                  onChange={() => onToggleStory(idx)}
                  className="mt-0.5 cursor-pointer"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs px-2 py-0.5 rounded bg-gray-700 text-gray-300">{s.teamName}</span>
                    <span className="text-gray-300">{s.summary}</span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">{s.description}</p>
                  <div className="flex items-center gap-2 mt-1">
                    {s.labels.map((l) => (
                      <span key={l} className="text-xs px-1.5 py-0.5 rounded-full bg-gray-700 text-gray-400">{l}</span>
                    ))}
                    <span className="text-xs text-gray-600">| {s.rationale}</span>
                  </div>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {plan.reassignments.length === 0 && plan.newStories.length === 0 && (
        <p className="text-sm text-gray-500">All tickets are correctly assigned — no changes needed.</p>
      )}

      {/* Action bar */}
      {(plan.reassignments.length > 0 || plan.newStories.length > 0) && (
        <div className="flex justify-end gap-2 pt-2 border-t border-gray-800">
          <button
            onClick={onDismiss}
            className="px-3 py-1.5 text-sm text-gray-400 hover:text-white cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={onApply}
            disabled={!hasSelections || loading}
            className="px-4 py-1.5 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Applying..." : `Apply Selected Changes (${selectedTickets.size + selectedStories.size})`}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Routing Labels Input ─────────────────────────────────────────────

function RoutingLabelsInput({
  labels,
  onChange,
}: {
  labels: string[];
  onChange: (labels: string[]) => void;
}) {
  const [text, setText] = useState(labels.join(", "));
  const [focused, setFocused] = useState(false);

  // Sync from parent when not focused (e.g. after server update)
  const displayValue = focused ? text : labels.join(", ");

  const commit = (val: string) => {
    const parsed = val
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    onChange(parsed);
  };

  return (
    <div>
      <label className="block text-xs text-gray-500 mb-1">Routing Labels (comma-separated)</label>
      <input
        value={displayValue}
        onFocus={() => {
          setText(labels.join(", "));
          setFocused(true);
        }}
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => {
          commit(e.target.value);
          setFocused(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commit(text);
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="e.g. backend, api, database"
        className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-purple-500"
      />
    </div>
  );
}

// ── Specialization Selector ──────────────────────────────────────────

function SpecializationSelector({
  value,
  onChange,
}: {
  value: string;
  onChange: (val: string) => void;
}) {
  const isCustom = !SPECIALIZATIONS.includes(value) && value !== "";
  const [showCustomInput, setShowCustomInput] = useState(isCustom);
  const [customValue, setCustomValue] = useState(isCustom ? value : "");

  const handleSelectChange = (selected: string) => {
    if (selected === "__other__") {
      setShowCustomInput(true);
      if (customValue) onChange(customValue);
    } else {
      setShowCustomInput(false);
      onChange(selected);
    }
  };

  const handleCustomChange = (val: string) => {
    const cleaned = val.toLowerCase().replace(/[^a-z0-9-]/g, "");
    setCustomValue(cleaned);
    if (cleaned) onChange(cleaned);
  };

  return (
    <div className="space-y-1.5">
      <select
        value={showCustomInput ? "__other__" : value}
        onChange={(e) => handleSelectChange(e.target.value)}
        className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-purple-500 cursor-pointer"
      >
        {SPECIALIZATIONS.map((s) => (
          <option key={s} value={s}>{s}</option>
        ))}
        <option value="__other__">other...</option>
      </select>
      {showCustomInput && (
        <input
          value={customValue}
          onChange={(e) => handleCustomChange(e.target.value)}
          placeholder="e.g. data-engineering"
          autoFocus
          className="w-full px-3 py-1.5 text-sm bg-gray-800 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-purple-500"
        />
      )}
    </div>
  );
}

// ── Validation Panel ─────────────────────────────────────────────────

const severityBadge: Record<string, string> = {
  critical: "bg-red-900/30 text-red-400 border-red-800/50",
  warning: "bg-yellow-900/30 text-yellow-400 border-yellow-800/50",
  ok: "bg-green-900/30 text-green-400 border-green-800/50",
};

function ValidationPanel({
  result,
  onFixGap,
  onApplySavedConfig,
  onDismiss,
  fixingRole,
  applyingConfig,
}: {
  result: ValidationResult;
  onFixGap: (role: string) => void;
  onApplySavedConfig: () => void;
  onDismiss: () => void;
  fixingRole: string | null;
  applyingConfig: boolean;
}) {
  const criticalGaps = result.gaps.filter((g) => g.severity === "critical");
  const warningGaps = result.gaps.filter((g) => g.severity === "warning");
  const okGaps = result.gaps.filter((g) => g.severity === "ok");
  const hasIssues = criticalGaps.length > 0 || warningGaps.length > 0;

  return (
    <div className="rounded-xl border border-green-800/50 bg-gray-900 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-green-300">Team Validation</h3>
        <button
          onClick={onDismiss}
          className="text-gray-500 hover:text-gray-300 cursor-pointer text-sm"
        >
          Dismiss
        </button>
      </div>

      {/* Summary */}
      <div className="flex gap-4 text-xs text-gray-400">
        <span>{result.totalTickets} active ticket(s) scanned</span>
        <span>{result.currentTeams} team(s)</span>
        <span>{result.currentAgents} agent(s)</span>
        {criticalGaps.length > 0 && (
          <span className="text-red-400">{criticalGaps.length} critical gap(s)</span>
        )}
        {warningGaps.length > 0 && (
          <span className="text-yellow-400">{warningGaps.length} warning(s)</span>
        )}
        {!hasIssues && (
          <span className="text-green-400">All roles covered</span>
        )}
      </div>

      {/* Saved config notice */}
      {result.hasSavedConfig && result.currentTeams === 0 && (
        <div className="rounded-lg border border-blue-800/50 bg-blue-900/10 p-3 flex items-center justify-between">
          <div>
            <p className="text-sm text-blue-300">
              Saved team config found from onboarding ({result.savedConfigTeams} teams, {result.savedConfigAgents} agents)
            </p>
            <p className="text-xs text-gray-500 mt-1">
              This configuration was created during onboarding but was never applied.
            </p>
          </div>
          <button
            onClick={onApplySavedConfig}
            disabled={applyingConfig}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ml-4"
          >
            {applyingConfig ? "Applying..." : "Apply Saved Config"}
          </button>
        </div>
      )}

      {result.hasSavedConfig && result.currentTeams > 0 && result.currentAgents < result.savedConfigAgents && (
        <div className="rounded-lg border border-blue-800/50 bg-blue-900/10 p-3 flex items-center justify-between">
          <div>
            <p className="text-sm text-blue-300">
              Saved config has {result.savedConfigTeams} teams / {result.savedConfigAgents} agents — current setup has {result.currentTeams} / {result.currentAgents}
            </p>
            <p className="text-xs text-gray-500 mt-1">
              Apply saved config to replace current teams with the onboarding configuration.
            </p>
          </div>
          <button
            onClick={onApplySavedConfig}
            disabled={applyingConfig}
            className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shrink-0 ml-4"
          >
            {applyingConfig ? "Applying..." : "Apply Saved Config"}
          </button>
        </div>
      )}

      {/* Role gaps */}
      {result.gaps.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-300 mb-2">Role Coverage</h4>
          <div className="space-y-1.5">
            {result.gaps.map((gap) => (
              <div
                key={gap.role}
                className="flex items-center justify-between rounded-lg bg-gray-800 px-3 py-2 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span
                    className={`text-xs px-2 py-0.5 rounded border ${severityBadge[gap.severity]}`}
                  >
                    {gap.severity === "critical"
                      ? "MISSING"
                      : gap.severity === "warning"
                        ? "LOW"
                        : "OK"}
                  </span>
                  <span className="font-medium text-gray-200">{gap.label}</span>
                  <span className="text-xs text-gray-500">
                    {gap.storiesRequiring} stories / {gap.agentsAvailable} agent(s)
                  </span>
                </div>
                {gap.severity !== "ok" && (
                  <button
                    onClick={() => onFixGap(gap.role)}
                    disabled={fixingRole === gap.role}
                    className="px-2 py-1 text-xs bg-green-700 hover:bg-green-600 text-white rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {fixingRole === gap.role ? "Adding..." : `+ Add ${gap.label} Agent`}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* All good message */}
      {!hasIssues && !result.hasSavedConfig && (
        <p className="text-sm text-green-400">
          Team configuration looks good — all required roles have agents assigned.
        </p>
      )}
    </div>
  );
}

// ── Add Team Form ────────────────────────────────────────────────────

function AddTeamForm({
  onAdd,
  onCancel,
}: {
  onAdd: (data: { name: string; specialization: string; model: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [specialization, setSpecialization] = useState("general");
  const [model, setModel] = useState("claude-sonnet-4-5");

  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/50 p-4 space-y-3">
      <h3 className="font-medium text-gray-300">Add Team</h3>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Name</label>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Backend"
            className="w-full px-3 py-1.5 text-sm bg-gray-900 border border-gray-700 rounded text-gray-300 focus:outline-none focus:border-purple-500"
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Specialization</label>
          <SpecializationSelector
            value={specialization}
            onChange={setSpecialization}
          />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Model</label>
          <ModelSelector value={model} onChange={setModel} compact persistKey="new_team" />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-gray-400 hover:text-white cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={() => name.trim() && onAdd({ name: name.trim(), specialization, model })}
          disabled={!name.trim()}
          className="px-4 py-1.5 text-sm bg-purple-600 hover:bg-purple-700 text-white rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Add Team
        </button>
      </div>
    </div>
  );
}
