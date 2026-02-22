"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getAllSettings,
  saveSettings,
  testJiraConnection,
  testGitHubConnection,
  testOpenRouterConnection,
  testLmStudioConnection,
  testTavilyConnection,
  seedTavilyKeyFromEnv,
  testIMessageChannel,
  testEmailChannel,
  testTeamsChannel,
  testWebhookChannel,
  testSlackConnection,
  seedChannelDefaults,
  getRoles,
  createRole,
  updateRole,
  deleteRole,
  getModelCatalog,
  getModelCatalogMeta,
  refreshModelCatalog,
  getUsers,
  createUser,
  deleteUser,
  resetUserPassword,
  type TestResult,
  type CatalogModel,
  type UserInfo,
} from "./actions";
import ModelSelector from "@/components/model-selector";

const SETTING_KEYS = {
  jiraEmail: "jira_email",
  jiraToken: "jira_api_token",
  jiraBaseUrl: "jira_base_url",
  openrouterKey: "openrouter_api_key",
  githubOrg: "github_org",
  githubDefaultToken: "github_default_token",
  lmStudioUrl: "lm_studio_url",
  tavilyKey: "tavily_api_key",
  modelTier1: "model_tier1",
  modelTier2: "model_tier2",
  modelTier3: "model_tier3",
  modelRouting: "model_routing",
  modelTriage: "model_triage",
  dispatcherMaxAgents: "dispatcher_max_agents",
  dispatcherPollInterval: "dispatcher_poll_interval",
  dispatcherMaxRetries: "dispatcher_max_retries",
  dispatcherWorktreeTtl: "dispatcher_worktree_ttl",
};

function formatCost(cost: number | null): string {
  if (cost === null) return "Max sub";
  if (cost === 0) return "Free";
  return `$${cost.toFixed(2)}/M`;
}

function scoreBadgeColor(score: number): string {
  if (score >= 90) return "text-green-400";
  if (score >= 70) return "text-blue-400";
  if (score >= 50) return "text-yellow-400";
  return "text-gray-400";
}

function maskSecret(val: string): string {
  if (!val) return "";
  if (val.length <= 4) return "••••";
  return "••••••••••••" + val.slice(-4);
}

type ConnectionStatus = {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
};

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState("api-keys");
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Editable secret fields — only populated when user clicks "Edit"
  const [editingSecrets, setEditingSecrets] = useState<Record<string, string | null>>({});

  // Connection test state per service
  const [connStatus, setConnStatus] = useState<Record<string, ConnectionStatus>>({
    jira: { status: "idle" },
    github: { status: "idle" },
    openrouter: { status: "idle" },
    lmstudio: { status: "idle" },
    tavily: { status: "idle" },
    imessage: { status: "idle" },
    email: { status: "idle" },
    teams: { status: "idle" },
    webhook: { status: "idle" },
    slack: { status: "idle" },
  });
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<TestResult | null>(null);

  // Roles management state
  type RoleData = { id: string; role: string; label: string; phase: number; prompt: string | null; color: string; isBuiltIn: boolean };
  const [roles, setRoles] = useState<RoleData[]>([]);
  const [showAddRole, setShowAddRole] = useState(false);
  const [newRole, setNewRole] = useState({ role: "", label: "", phase: 50, prompt: "", color: "gray" });
  const [editingRole, setEditingRole] = useState<string | null>(null);
  const [roleError, setRoleError] = useState<string | null>(null);

  // Model catalog state
  const [catalog, setCatalog] = useState<CatalogModel[]>([]);
  const [catalogFetchedAt, setCatalogFetchedAt] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  // User management state
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [newUser, setNewUser] = useState({ email: "", password: "", confirmPassword: "", name: "" });
  const [userError, setUserError] = useState<string | null>(null);
  const [resettingPassword, setResettingPassword] = useState<string | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const load = useCallback(async () => {
    // Auto-seed Tavily key from env on first load
    await seedTavilyKeyFromEnv();
    const [data, rolesData, catalogData, catalogMeta, usersData] = await Promise.all([
      getAllSettings(),
      getRoles(),
      getModelCatalog(),
      getModelCatalogMeta(),
      getUsers(),
    ]);
    setSettings(data);
    setRoles(rolesData);
    setCatalog(catalogData);
    setCatalogFetchedAt(catalogMeta.fetchedAt);
    setUsers(usersData);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const update = (key: string, value: string) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  };

  const handleSave = async () => {
    setSaving(true);
    // Merge any edited secrets into settings
    const toSave = { ...settings };
    for (const [key, val] of Object.entries(editingSecrets)) {
      if (val !== null) toSave[key] = val;
    }
    await saveSettings(toSave);
    setEditingSecrets({});
    setSaving(false);
    setSaved(true);
    // Reload to get fresh state
    await load();
    setTimeout(() => setSaved(false), 2000);
  };

  const handleTest = async (service: string, testFn: () => Promise<TestResult>) => {
    setConnStatus((prev) => ({ ...prev, [service]: { status: "testing" } }));
    // Save first so the test uses latest values
    const toSave = { ...settings };
    for (const [key, val] of Object.entries(editingSecrets)) {
      if (val !== null) toSave[key] = val;
    }
    await saveSettings(toSave);
    setEditingSecrets({});
    await load();

    const result = await testFn();
    setConnStatus((prev) => ({
      ...prev,
      [service]: {
        status: result.ok ? "success" : "error",
        message: result.message,
      },
    }));
  };

  const tabs = [
    { id: "api-keys", label: "API Keys" },
    { id: "models", label: "Models" },
    { id: "dispatcher", label: "Dispatcher" },
    { id: "roles", label: "Roles" },
    { id: "channels", label: "Channels" },
    { id: "notifications", label: "Notifications" },
    { id: "users", label: "Users" },
  ];

  if (!loaded) {
    return (
      <div className="flex items-center justify-center py-20 text-gray-400">
        Loading settings...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>

      <div className="flex gap-1 rounded-lg border border-gray-800 bg-gray-900 p-1">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`rounded-md px-4 py-2 text-sm transition-colors ${
              activeTab === tab.id
                ? "bg-gray-800 text-white"
                : "text-gray-400 hover:text-gray-200"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="space-y-4">
        {activeTab === "api-keys" && (
          <div className="space-y-4">
            {/* Jira Card */}
            <ServiceCard
              title="Jira"
              icon="J"
              iconColor="bg-blue-600"
              status={connStatus.jira}
              onTest={() => handleTest("jira", testJiraConnection)}
            >
              <FieldRow label="Base URL">
                <input
                  type="text"
                  value={settings[SETTING_KEYS.jiraBaseUrl] || "https://mbakers.atlassian.net"}
                  onChange={(e) => update(SETTING_KEYS.jiraBaseUrl, e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                />
              </FieldRow>
              <FieldRow label="Email">
                <input
                  type="text"
                  value={settings[SETTING_KEYS.jiraEmail] || ""}
                  onChange={(e) => update(SETTING_KEYS.jiraEmail, e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                />
              </FieldRow>
              <SecretField
                label="API Token"
                settingKey={SETTING_KEYS.jiraToken}
                value={settings[SETTING_KEYS.jiraToken] || ""}
                editingSecrets={editingSecrets}
                setEditingSecrets={setEditingSecrets}
                onChange={(v) => update(SETTING_KEYS.jiraToken, v)}
              />
            </ServiceCard>

            {/* GitHub Card */}
            <ServiceCard
              title="GitHub"
              icon="G"
              iconColor="bg-gray-600"
              status={connStatus.github}
              onTest={() => handleTest("github", testGitHubConnection)}
            >
              <FieldRow label="Organization">
                <input
                  type="text"
                  value={settings[SETTING_KEYS.githubOrg] || "michaelbaker-dev"}
                  onChange={(e) => update(SETTING_KEYS.githubOrg, e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                />
              </FieldRow>
              <SecretField
                label="Default GitHub Token (Optional)"
                settingKey={SETTING_KEYS.githubDefaultToken}
                value={settings[SETTING_KEYS.githubDefaultToken] || ""}
                editingSecrets={editingSecrets}
                setEditingSecrets={setEditingSecrets}
                onChange={(v) => update(SETTING_KEYS.githubDefaultToken, v)}
              />
              <div className="text-xs text-gray-500">
                Used when a project doesn&apos;t have its own token. Falls back to <code className="text-gray-400">gh</code> CLI auth if not set.
              </div>
            </ServiceCard>

            {/* OpenRouter Card */}
            <ServiceCard
              title="OpenRouter"
              subtitle="Cloud AI"
              icon="O"
              iconColor="bg-purple-600"
              status={connStatus.openrouter}
              onTest={() => handleTest("openrouter", testOpenRouterConnection)}
            >
              <SecretField
                label="API Key"
                settingKey={SETTING_KEYS.openrouterKey}
                value={settings[SETTING_KEYS.openrouterKey] || ""}
                editingSecrets={editingSecrets}
                setEditingSecrets={setEditingSecrets}
                onChange={(v) => update(SETTING_KEYS.openrouterKey, v)}
              />
            </ServiceCard>

            {/* LM Studio Card */}
            <ServiceCard
              title="LM Studio"
              subtitle="Local AI"
              icon="L"
              iconColor="bg-emerald-600"
              status={connStatus.lmstudio}
              onTest={() => handleTest("lmstudio", testLmStudioConnection)}
            >
              <FieldRow label="URL">
                <input
                  type="text"
                  value={settings[SETTING_KEYS.lmStudioUrl] || "http://192.168.56.203:1234"}
                  onChange={(e) => update(SETTING_KEYS.lmStudioUrl, e.target.value)}
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                />
              </FieldRow>
            </ServiceCard>

            {/* Tavily Card */}
            <ServiceCard
              title="Tavily"
              subtitle="Web Search"
              icon="T"
              iconColor="bg-yellow-600"
              status={connStatus.tavily}
              onTest={() => handleTest("tavily", testTavilyConnection)}
            >
              <SecretField
                label="API Key"
                settingKey={SETTING_KEYS.tavilyKey}
                value={settings[SETTING_KEYS.tavilyKey] || ""}
                editingSecrets={editingSecrets}
                setEditingSecrets={setEditingSecrets}
                onChange={(v) => update(SETTING_KEYS.tavilyKey, v)}
              />
              <div className="text-xs text-gray-500">
                Enables web search for PRD/ARD generation and Lyra chat
              </div>
            </ServiceCard>
          </div>
        )}

        {activeTab === "models" && (
          <div className="space-y-4">
            {/* Refresh bar */}
            <div className="flex items-center justify-between rounded-xl border border-dashed border-gray-700 bg-gray-900/50 p-4">
              <div>
                <h2 className="text-lg font-semibold">Model Catalog</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  {catalogFetchedAt
                    ? `Last refreshed: ${timeAgo(catalogFetchedAt)} — ${catalog.length} models`
                    : "Not yet refreshed — showing default models"}
                </p>
              </div>
              <div className="flex items-center gap-3">
                {refreshError && (
                  <span className="text-xs text-red-400 max-w-xs truncate">{refreshError}</span>
                )}
                <button
                  onClick={async () => {
                    setRefreshing(true);
                    setRefreshError(null);
                    const result = await refreshModelCatalog();
                    if (result.success) {
                      const [fresh, meta] = await Promise.all([getModelCatalog(), getModelCatalogMeta()]);
                      setCatalog(fresh);
                      setCatalogFetchedAt(meta.fetchedAt);
                    } else {
                      setRefreshError(result.error || "Refresh failed");
                    }
                    setRefreshing(false);
                  }}
                  disabled={refreshing}
                  className="rounded-lg bg-purple-600 px-4 py-1.5 text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors flex items-center gap-2"
                >
                  {refreshing ? (
                    <>
                      <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Refreshing...
                    </>
                  ) : (
                    "Refresh Models"
                  )}
                </button>
              </div>
            </div>

            {/* Agent Model Tiers */}
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Agent Model Tiers</h2>
                <p className="text-sm text-gray-400 mt-1">
                  All agents use a global 3-tier escalation system. The dispatcher automatically selects the tier based on how many times a ticket has failed.
                </p>
              </div>
              {[
                {
                  label: "Tier 1 — Primary",
                  key: SETTING_KEYS.modelTier1,
                  default: "claude-code/sonnet",
                  description: "Used for first 3 attempts (0-2 failures). Best cost/capability balance.",
                  badge: "bg-green-900/30 text-green-400 border-green-800/50",
                },
                {
                  label: "Tier 2 — Escalation",
                  key: SETTING_KEYS.modelTier2,
                  default: "claude-code/opus",
                  description: "Used after 3+ failures. Smarter model for harder or repeated failures.",
                  badge: "bg-yellow-900/30 text-yellow-400 border-yellow-800/50",
                },
                {
                  label: "Tier 3 — Fallback",
                  key: SETTING_KEYS.modelTier3,
                  default: "openrouter/auto",
                  description: "Used when Claude Max budget is exhausted. Preserves token budget.",
                  badge: "bg-red-900/30 text-red-400 border-red-800/50",
                },
              ].map((tier) => {
                const selected = catalog.find((m) => m.id === (settings[tier.key] || tier.default));
                return (
                  <div key={tier.key} className="rounded-lg border border-gray-700 bg-gray-800/30 p-4 space-y-2">
                    <div className="flex items-center justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className={`rounded px-2 py-0.5 text-xs font-medium border ${tier.badge}`}>
                            {tier.label}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 mt-1">{tier.description}</p>
                      </div>
                      <ModelSelector
                        value={settings[tier.key] || tier.default}
                        onChange={(v) => update(tier.key, v)}
                        compact
                      />
                    </div>
                    {selected && <ModelInfoBar model={selected} />}
                  </div>
                );
              })}
            </div>

            {/* Support Models */}
            <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-6">
              <div>
                <h2 className="text-lg font-semibold">Support Models</h2>
                <p className="text-sm text-gray-400 mt-1">
                  Non-agent tasks like routing and triage analysis. These do not use the tier system.
                </p>
              </div>
              {[
                { role: "Lyra (routing)", key: SETTING_KEYS.modelRouting, default: "openrouter/auto" },
                { role: "Bug Triage / Failure Analysis", key: SETTING_KEYS.modelTriage, default: "openrouter/auto" },
              ].map((entry) => {
                const selected = catalog.find((m) => m.id === (settings[entry.key] || entry.default));
                return (
                  <div key={entry.role} className="rounded-lg border border-gray-700 bg-gray-800/30 p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="font-medium">{entry.role}</div>
                      <ModelSelector
                        value={settings[entry.key] || entry.default}
                        onChange={(v) => update(entry.key, v)}
                        compact
                      />
                    </div>
                    {selected && <ModelInfoBar model={selected} />}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {activeTab === "dispatcher" && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-6">
            <h2 className="text-lg font-semibold">Dispatcher Configuration</h2>
            <div className="grid grid-cols-2 gap-6">
              {[
                { label: "Max Parallel Agents", key: SETTING_KEYS.dispatcherMaxAgents, default: "4" },
                { label: "Poll Interval (minutes)", key: SETTING_KEYS.dispatcherPollInterval, default: "15" },
                { label: "Max Retries per Ticket", key: SETTING_KEYS.dispatcherMaxRetries, default: "5" },
                { label: "Worktree Cleanup TTL (hours)", key: SETTING_KEYS.dispatcherWorktreeTtl, default: "24" },
              ].map((field) => (
                <div key={field.key}>
                  <label className="block text-sm text-gray-400">{field.label}</label>
                  <input
                    type="number"
                    value={settings[field.key] || field.default}
                    onChange={(e) => update(field.key, e.target.value)}
                    className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2"
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "channels" && (
          <div className="space-y-4">
            {/* Import from OpenClaw */}
            <div className="rounded-xl border border-dashed border-gray-700 bg-gray-900/50 p-4 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-semibold text-gray-200">Import from OpenClaw</h3>
                <p className="text-xs text-gray-500">Pull Teams, iMessage, and email config from ~/.openclaw</p>
              </div>
              <div className="flex items-center gap-3">
                {importResult && (
                  <span className={`text-xs ${importResult.ok ? "text-green-400" : "text-red-400"}`}>
                    {importResult.message}
                  </span>
                )}
                <button
                  onClick={async () => {
                    setImporting(true);
                    setImportResult(null);
                    const result = await seedChannelDefaults();
                    setImportResult(result);
                    setImporting(false);
                    if (result.ok) await load();
                  }}
                  disabled={importing}
                  className="rounded-lg bg-purple-600 px-4 py-1.5 text-sm font-medium hover:bg-purple-700 disabled:opacity-50 transition-colors"
                >
                  {importing ? "Importing..." : "Import"}
                </button>
              </div>
            </div>

            {/* iMessage */}
            <ServiceCard
              title="iMessage"
              subtitle="via imsg CLI"
              icon="iM"
              iconColor="bg-green-600"
              status={connStatus.imessage}
              onTest={() => handleTest("imessage", testIMessageChannel)}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Channel</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.imessage_enabled === "true"}
                    onChange={(e) => update("imessage_enabled", e.target.checked ? "true" : "false")}
                    className="rounded border-gray-700"
                  />
                  Enabled
                </label>
              </div>
              <FieldRow label="Recipient Phone Number">
                <input
                  type="text"
                  value={settings.imessage_recipient || ""}
                  onChange={(e) => update("imessage_recipient", e.target.value)}
                  placeholder="+1234567890"
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                />
              </FieldRow>
            </ServiceCard>

            {/* Email */}
            <ServiceCard
              title="Email"
              subtitle="Graph API + SMTP fallback"
              icon="@"
              iconColor="bg-blue-600"
              status={connStatus.email}
              onTest={() => handleTest("email", testEmailChannel)}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">Uses Teams Azure credentials for Graph API. SMTP fields are optional fallback.</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.email_enabled === "true"}
                    onChange={(e) => update("email_enabled", e.target.checked ? "true" : "false")}
                    className="rounded border-gray-700"
                  />
                  Enabled
                </label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FieldRow label="From Address">
                  <input type="text" value={settings.email_from || "lyra@baker.email"} onChange={(e) => update("email_from", e.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
                </FieldRow>
                <FieldRow label="To Address">
                  <input type="text" value={settings.email_to || ""} onChange={(e) => update("email_to", e.target.value)} placeholder="michael@baker.email" className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
                </FieldRow>
              </div>
              <details className="mt-2">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">SMTP fallback settings</summary>
                <div className="grid grid-cols-2 gap-4 mt-3">
                  <FieldRow label="SMTP Host">
                    <input type="text" value={settings.smtp_host || ""} onChange={(e) => update("smtp_host", e.target.value)} placeholder="smtp.office365.com" className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
                  </FieldRow>
                  <FieldRow label="SMTP Port">
                    <input type="text" value={settings.smtp_port || "587"} onChange={(e) => update("smtp_port", e.target.value)} className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
                  </FieldRow>
                  <FieldRow label="SMTP User">
                    <input type="text" value={settings.smtp_user || ""} onChange={(e) => update("smtp_user", e.target.value)} placeholder="lyra@baker.email" className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
                  </FieldRow>
                  <SecretField label="SMTP Password" settingKey="smtp_password" value={settings.smtp_password || ""} editingSecrets={editingSecrets} setEditingSecrets={setEditingSecrets} onChange={(v) => update("smtp_password", v)} />
                </div>
              </details>
            </ServiceCard>

            {/* MS Teams */}
            <ServiceCard
              title="MS Teams"
              subtitle="Bot Framework"
              icon="T"
              iconColor="bg-indigo-600"
              status={connStatus.teams}
              onTest={() => handleTest("teams", testTeamsChannel)}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">Azure Bot registration (shared with Graph email)</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.teams_enabled === "true"}
                    onChange={(e) => update("teams_enabled", e.target.checked ? "true" : "false")}
                    className="rounded border-gray-700"
                  />
                  Enabled
                </label>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <FieldRow label="App ID">
                  <input type="text" value={settings.teams_app_id || ""} onChange={(e) => update("teams_app_id", e.target.value)} placeholder="5c384f3c-..." className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
                </FieldRow>
                <SecretField label="App Password" settingKey="teams_app_password" value={settings.teams_app_password || ""} editingSecrets={editingSecrets} setEditingSecrets={setEditingSecrets} onChange={(v) => update("teams_app_password", v)} />
              </div>
              <FieldRow label="Tenant ID">
                <input type="text" value={settings.teams_tenant_id || ""} onChange={(e) => update("teams_tenant_id", e.target.value)} placeholder="763c82b0-..." className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
              </FieldRow>
              <FieldRow label="Conversation Reference">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={settings.teams_conversation_ref ? "(configured)" : ""}
                    readOnly
                    placeholder="Not configured — import from OpenClaw"
                    className="w-full rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2 text-sm text-gray-500"
                  />
                  {settings.teams_conversation_ref && (
                    <span className="text-xs text-green-400 whitespace-nowrap">Ready</span>
                  )}
                </div>
                <p className="text-xs text-gray-600 mt-1">
                  If test fails, open Teams and message &quot;Lyra-ai-bot&quot; directly, then re-import from OpenClaw.
                </p>
              </FieldRow>
            </ServiceCard>

            {/* Slack */}
            <ServiceCard
              title="Slack"
              subtitle="Bot API"
              icon="S"
              iconColor="bg-pink-600"
              status={connStatus.slack}
              onTest={() => handleTest("slack", testSlackConnection)}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-gray-500">Per-project channels auto-created during onboarding</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.slack_enabled === "true"}
                    onChange={(e) => update("slack_enabled", e.target.checked ? "true" : "false")}
                    className="rounded border-gray-700"
                  />
                  Enabled
                </label>
              </div>
              <SecretField
                label="Bot Token (xoxb-...)"
                settingKey="slack_bot_token"
                value={settings.slack_bot_token || ""}
                editingSecrets={editingSecrets}
                setEditingSecrets={setEditingSecrets}
                onChange={(v) => update("slack_bot_token", v)}
              />
              <FieldRow label="#lyra-general Channel ID">
                <input
                  type="text"
                  value={settings.slack_general_channel_id || ""}
                  onChange={(e) => update("slack_general_channel_id", e.target.value)}
                  placeholder="Auto-created on first test"
                  className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                />
              </FieldRow>
              <details className="mt-2">
                <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-300">Bidirectional chat (Slack Events API)</summary>
                <div className="mt-3 space-y-3">
                  <SecretField
                    label="Signing Secret"
                    settingKey="slack_signing_secret"
                    value={settings.slack_signing_secret || ""}
                    editingSecrets={editingSecrets}
                    setEditingSecrets={setEditingSecrets}
                    onChange={(v) => update("slack_signing_secret", v)}
                  />
                  <FieldRow label="Events Request URL">
                    <input
                      type="text"
                      value={settings.slack_events_url || ""}
                      onChange={(e) => update("slack_events_url", e.target.value)}
                      placeholder="https://your-domain.ts.net/api/slack/events"
                      className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-600 mt-1">
                      Your public URL for Slack Event Subscriptions. Subscribe to bot event: <code className="text-gray-400">message.channels</code>
                    </p>
                  </FieldRow>
                  <FieldRow label="Owner User ID">
                    <input
                      type="text"
                      value={settings.slack_owner_user_id || ""}
                      onChange={(e) => update("slack_owner_user_id", e.target.value)}
                      placeholder="U0AFLP2111A"
                      className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
                    />
                    <p className="text-xs text-gray-600 mt-1">
                      Your Slack member ID. Lyra will auto-invite you to every channel it creates. Find it in Slack: Profile → ⋯ → Copy member ID.
                    </p>
                  </FieldRow>
                </div>
              </details>
            </ServiceCard>

            {/* Webhook */}
            <ServiceCard
              title="Webhook"
              subtitle="Generic POST"
              icon="W"
              iconColor="bg-orange-600"
              status={connStatus.webhook}
              onTest={() => handleTest("webhook", testWebhookChannel)}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">Generic POST</span>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={settings.webhook_enabled === "true"}
                    onChange={(e) => update("webhook_enabled", e.target.checked ? "true" : "false")}
                    className="rounded border-gray-700"
                  />
                  Enabled
                </label>
              </div>
              <FieldRow label="Webhook URL">
                <input type="text" value={settings.webhook_url || ""} onChange={(e) => update("webhook_url", e.target.value)} placeholder="https://hooks.slack.com/..." className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm" />
              </FieldRow>
            </ServiceCard>
          </div>
        )}

        {activeTab === "roles" && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold">Agent Roles</h2>
                <p className="text-sm text-gray-400 mt-1">
                  Roles determine agent behavior and story execution order (phase).
                </p>
              </div>
              <button
                onClick={() => setShowAddRole(true)}
                className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
              >
                + Add Role
              </button>
            </div>

            {roleError && (
              <div className="rounded-lg border border-red-800 bg-red-900/20 p-2 text-sm text-red-300">
                {roleError}
              </div>
            )}

            {showAddRole && (
              <div className="rounded-lg border border-gray-700 bg-gray-800/50 p-4 space-y-3">
                <h3 className="text-sm font-medium text-white">New Role</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-400">Role ID</label>
                    <input type="text" value={newRole.role} onChange={(e) => setNewRole((p) => ({ ...p, role: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") }))} placeholder="e.g. security" className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">Display Label</label>
                    <input type="text" value={newRole.label} onChange={(e) => setNewRole((p) => ({ ...p, label: e.target.value }))} placeholder="e.g. Security" className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">Phase (execution order)</label>
                    <input type="number" value={newRole.phase} onChange={(e) => setNewRole((p) => ({ ...p, phase: parseInt(e.target.value) || 50 }))} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-400">Color</label>
                    <select value={newRole.color} onChange={(e) => setNewRole((p) => ({ ...p, color: e.target.value }))} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm">
                      {["gray", "blue", "red", "green", "yellow", "purple", "amber", "cyan", "indigo", "teal"].map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs text-gray-400">System Prompt</label>
                  <textarea value={newRole.prompt} onChange={(e) => setNewRole((p) => ({ ...p, prompt: e.target.value }))} rows={3} placeholder="You are a ... agent." className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm" />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setRoleError(null);
                      if (!newRole.role || !newRole.label) { setRoleError("Role ID and label are required"); return; }
                      const result = await createRole(newRole);
                      if (!result.success) { setRoleError(result.error || "Failed to create role"); return; }
                      const fresh = await getRoles();
                      setRoles(fresh);
                      setShowAddRole(false);
                      setNewRole({ role: "", label: "", phase: 50, prompt: "", color: "gray" });
                    }}
                    className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
                  >
                    Create
                  </button>
                  <button onClick={() => setShowAddRole(false)} className="rounded-lg border border-gray-600 px-4 py-2 text-sm text-gray-300 hover:bg-gray-700 transition-colors">Cancel</button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {roles.map((role) => (
                <div key={role.id} className="rounded-lg border border-gray-700 bg-gray-800/30 p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium bg-${role.color}-900/30 text-${role.color}-400 border border-${role.color}-800/50`}>
                        {role.label}
                      </span>
                      <span className="text-sm text-gray-300 font-mono">{role.role}</span>
                      <span className="text-xs text-gray-500">Phase {role.phase}</span>
                      {role.isBuiltIn && <span className="text-xs text-gray-600">built-in</span>}
                    </div>
                    <div className="flex gap-1">
                      <button
                        onClick={() => setEditingRole(editingRole === role.id ? null : role.id)}
                        className="rounded px-2 py-1 text-xs text-gray-400 hover:bg-gray-700"
                      >
                        {editingRole === role.id ? "Close" : "Edit"}
                      </button>
                      {!role.isBuiltIn && (
                        <button
                          onClick={async () => {
                            setRoleError(null);
                            const result = await deleteRole(role.id);
                            if (!result.success) { setRoleError(result.error || "Failed to delete"); return; }
                            setRoles((prev) => prev.filter((r) => r.id !== role.id));
                          }}
                          className="rounded px-2 py-1 text-xs text-red-400 hover:bg-red-900/30"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                  {editingRole === role.id && (
                    <div className="mt-3 space-y-2 border-t border-gray-700 pt-3">
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-gray-400">Label</label>
                          <input type="text" defaultValue={role.label} onBlur={(e) => {
                            if (e.target.value !== role.label) {
                              updateRole(role.id, { label: e.target.value }).then(() => getRoles().then(setRoles));
                            }
                          }} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm" />
                        </div>
                        <div>
                          <label className="text-xs text-gray-400">Phase</label>
                          <input type="number" defaultValue={role.phase} onBlur={(e) => {
                            const v = parseInt(e.target.value);
                            if (!isNaN(v) && v !== role.phase) {
                              updateRole(role.id, { phase: v }).then(() => getRoles().then(setRoles));
                            }
                          }} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm" />
                        </div>
                      </div>
                      <div>
                        <label className="text-xs text-gray-400">System Prompt</label>
                        <textarea defaultValue={role.prompt || ""} rows={4} onBlur={(e) => {
                          if (e.target.value !== (role.prompt || "")) {
                            updateRole(role.id, { prompt: e.target.value || null }).then(() => getRoles().then(setRoles));
                          }
                        }} className="mt-1 w-full rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm font-mono" />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {activeTab === "notifications" && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-6">
            <h2 className="text-lg font-semibold">Severity Routing</h2>
            <p className="text-sm text-gray-400 mb-4">
              Choose which channels receive notifications for each severity level.
            </p>
            {(["info", "warning", "critical"] as const).map((severity) => {
              const key = `routing_${severity}`;
              const current = settings[key] || (severity === "info" ? "in_app" : severity === "warning" ? "in_app,imessage" : "in_app,imessage,email");
              const channels = current.split(",");
              return (
                <div key={severity} className="flex items-center gap-4">
                  <span className={`w-20 text-sm font-medium ${severity === "critical" ? "text-red-400" : severity === "warning" ? "text-yellow-400" : "text-gray-400"}`}>
                    {severity}
                  </span>
                  {["in_app", "imessage", "email", "webhook", "teams", "slack"].map((ch) => (
                    <label key={ch} className="flex items-center gap-1 text-xs text-gray-400">
                      <input
                        type="checkbox"
                        checked={channels.includes(ch)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...channels, ch]
                            : channels.filter((c) => c !== ch);
                          update(key, next.join(","));
                        }}
                        className="rounded border-gray-700"
                      />
                      {ch}
                    </label>
                  ))}
                </div>
              );
            })}
          </div>
        )}

        {activeTab === "users" && (
          <div className="rounded-xl border border-gray-800 bg-gray-900 p-6 space-y-6">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">User Accounts</h2>
              <button
                onClick={() => { setShowAddUser(true); setUserError(null); }}
                className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium hover:bg-blue-700"
              >
                Add User
              </button>
            </div>

            {userError && (
              <div className="rounded-lg border border-red-800 bg-red-900/30 px-4 py-3 text-sm text-red-300">
                {userError}
              </div>
            )}

            {showAddUser && (
              <div className="rounded-lg border border-gray-700 bg-gray-800 p-4 space-y-3">
                <h3 className="text-sm font-medium">New User</h3>
                <div className="grid grid-cols-2 gap-3">
                  <input
                    type="email"
                    placeholder="Email"
                    value={newUser.email}
                    onChange={(e) => setNewUser({ ...newUser, email: e.target.value })}
                    className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                  />
                  <input
                    type="text"
                    placeholder="Name (optional)"
                    value={newUser.name}
                    onChange={(e) => setNewUser({ ...newUser, name: e.target.value })}
                    className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                  />
                  <input
                    type="password"
                    placeholder="Password (min 12 chars)"
                    value={newUser.password}
                    onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                    className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                  />
                  <input
                    type="password"
                    placeholder="Confirm Password"
                    value={newUser.confirmPassword}
                    onChange={(e) => setNewUser({ ...newUser, confirmPassword: e.target.value })}
                    className="rounded-lg border border-gray-700 bg-gray-900 px-3 py-2 text-sm"
                  />
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={async () => {
                      setUserError(null);
                      if (newUser.password !== newUser.confirmPassword) {
                        setUserError("Passwords do not match");
                        return;
                      }
                      const result = await createUser(newUser.email, newUser.password, newUser.name);
                      if (!result.success) {
                        setUserError(result.error || "Failed to create user");
                        return;
                      }
                      setNewUser({ email: "", password: "", confirmPassword: "", name: "" });
                      setShowAddUser(false);
                      setUsers(await getUsers());
                    }}
                    className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium hover:bg-blue-700"
                  >
                    Create
                  </button>
                  <button
                    onClick={() => { setShowAddUser(false); setUserError(null); }}
                    className="rounded-lg border border-gray-700 px-4 py-1.5 text-sm hover:bg-gray-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-2">
              {users.map((user) => (
                <div key={user.id} className="flex items-center justify-between rounded-lg border border-gray-700 bg-gray-800 px-4 py-3">
                  <div>
                    <span className="font-medium">{user.email}</span>
                    {user.name && <span className="ml-2 text-sm text-gray-400">({user.name})</span>}
                    <span className="ml-3 rounded bg-blue-900/50 px-2 py-0.5 text-xs text-blue-300">{user.role}</span>
                    <div className="text-xs text-gray-500 mt-0.5">
                      Last login: {user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : "Never"}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {resettingPassword === user.id ? (
                      <div className="flex gap-2">
                        <input
                          type="password"
                          placeholder="New password (min 12)"
                          value={resetPassword}
                          onChange={(e) => setResetPassword(e.target.value)}
                          className="rounded border border-gray-700 bg-gray-900 px-2 py-1 text-sm w-48"
                        />
                        <button
                          onClick={async () => {
                            setUserError(null);
                            const result = await resetUserPassword(user.id, resetPassword);
                            if (!result.success) {
                              setUserError(result.error || "Failed to reset password");
                              return;
                            }
                            setResettingPassword(null);
                            setResetPassword("");
                          }}
                          className="rounded border border-gray-700 px-2 py-1 text-xs hover:bg-gray-700"
                        >
                          Save
                        </button>
                        <button
                          onClick={() => { setResettingPassword(null); setResetPassword(""); }}
                          className="rounded border border-gray-700 px-2 py-1 text-xs hover:bg-gray-700"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <>
                        <button
                          onClick={() => { setResettingPassword(user.id); setResetPassword(""); setUserError(null); }}
                          className="rounded border border-gray-700 px-3 py-1 text-xs hover:bg-gray-700"
                        >
                          Reset Password
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(`Delete user "${user.email}"?`)) return;
                            setUserError(null);
                            const result = await deleteUser(user.id);
                            if (!result.success) {
                              setUserError(result.error || "Failed to delete user");
                              return;
                            }
                            setUsers(await getUsers());
                          }}
                          className="rounded border border-red-800 px-3 py-1 text-xs text-red-400 hover:bg-red-900/30"
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
              {users.length === 0 && (
                <p className="text-sm text-gray-500 text-center py-8">No users found.</p>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-3">
        {saved && (
          <span className="text-sm text-green-400">Settings saved</span>
        )}
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-lg bg-blue-600 px-6 py-2 font-medium hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </div>
  );
}

// ── Model Selection Components ───────────────────────────────────────

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ModelInfoBar({ model }: { model: CatalogModel }) {
  return (
    <div className="flex items-center gap-3 text-xs text-gray-400">
      <span className={`font-medium ${scoreBadgeColor(model.codingScore)}`}>
        {"\u2605"} {model.codingScore}/100
      </span>
      <span className="text-gray-600">|</span>
      <span>
        {model.source === "claude-code"
          ? "Max subscription"
          : model.source === "local"
            ? "Free (local)"
            : model.promptCostPerM !== null
              ? `${formatCost(model.promptCostPerM)} in / ${formatCost(model.completionCostPerM)} out`
              : "Cost varies"}
      </span>
      <span className="text-gray-600">|</span>
      <span>{(model.contextLength / 1000).toFixed(0)}K ctx</span>
      {model.description && (
        <>
          <span className="text-gray-600">|</span>
          <span className="text-gray-500 truncate max-w-xs">{model.description}</span>
        </>
      )}
    </div>
  );
}

// ── Service Card ─────────────────────────────────────────────────────

function ServiceCard({
  title,
  subtitle,
  icon,
  iconColor,
  status,
  onTest,
  children,
}: {
  title: string;
  subtitle?: string;
  icon: string;
  iconColor: string;
  status: ConnectionStatus;
  onTest: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg text-sm font-bold text-white ${iconColor}`}>
            {icon}
          </div>
          <div>
            <h3 className="font-semibold text-gray-100">{title}</h3>
            {subtitle && <span className="text-xs text-gray-500">{subtitle}</span>}
          </div>
        </div>
        <StatusIndicator status={status} />
      </div>

      <div className="space-y-3">
        {children}
      </div>

      <div className="flex items-center justify-end gap-3 pt-1">
        <button
          onClick={onTest}
          disabled={status.status === "testing"}
          className="rounded-lg border border-gray-700 px-4 py-1.5 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white disabled:opacity-50 transition-colors"
        >
          {status.status === "testing" ? "Testing..." : "Test Connection"}
        </button>
      </div>
    </div>
  );
}

function StatusIndicator({ status }: { status: ConnectionStatus }) {
  if (status.status === "idle") {
    return <span className="text-xs text-gray-600">Not tested</span>;
  }
  if (status.status === "testing") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-gray-400">
        <span className="h-2 w-2 animate-pulse rounded-full bg-gray-400" />
        Testing...
      </span>
    );
  }
  if (status.status === "success") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-green-400">
        <span className="h-2 w-2 rounded-full bg-green-400" />
        {status.message}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-red-400 max-w-xs truncate" title={status.message}>
      <span className="h-2 w-2 rounded-full bg-red-400 shrink-0" />
      {status.message}
    </span>
  );
}

// ── Field components ─────────────────────────────────────────────────

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

function SecretField({
  label,
  settingKey,
  value,
  editingSecrets,
  setEditingSecrets,
  onChange,
}: {
  label: string;
  settingKey: string;
  value: string;
  editingSecrets: Record<string, string | null>;
  setEditingSecrets: React.Dispatch<React.SetStateAction<Record<string, string | null>>>;
  onChange: (v: string) => void;
}) {
  const isEditing = editingSecrets[settingKey] !== undefined;
  const configured = !!value;

  if (!isEditing) {
    return (
      <div>
        <label className="block text-sm text-gray-400 mb-1">{label}</label>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-300 font-mono">
            {configured ? maskSecret(value) : <span className="text-gray-600">Not configured</span>}
          </span>
          <button
            onClick={() => setEditingSecrets((p) => ({ ...p, [settingKey]: "" }))}
            className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-800"
          >
            {configured ? "Rotate" : "Set"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <label className="block text-sm text-gray-400 mb-1">{label}</label>
      <div className="flex gap-2">
        <input
          type="password"
          value={editingSecrets[settingKey] ?? ""}
          onChange={(e) => {
            setEditingSecrets((p) => ({ ...p, [settingKey]: e.target.value }));
          }}
          placeholder="Enter new value..."
          className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm"
        />
        <button
          onClick={() => {
            const val = editingSecrets[settingKey];
            if (val) onChange(val);
            setEditingSecrets((p) => {
              const next = { ...p };
              delete next[settingKey];
              return next;
            });
          }}
          className="rounded border border-gray-700 px-3 py-1 text-sm hover:bg-gray-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
