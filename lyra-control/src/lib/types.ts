export type ProjectStatus = "active" | "archived" | "onboarding";

export type AgentRole = string; // Data-driven: validated against RoleConfig table

export type AgentStatus = "idle" | "running" | "errored" | "rate-limited";

export type SessionStatus = "running" | "completed" | "failed" | "cancelled";

export type TicketStatus =
  | "Backlog"
  | "To Do"
  | "In Progress"
  | "Code Review"
  | "QA"
  | "QA Passed"
  | "Done";

export type OnboardingStep =
  | "project-info"
  | "github"
  | "jira"
  | "scaffold"
  | "team-setup"
  | "validation";

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface Project {
  id: string;
  name: string;
  path: string;
  jiraKey: string;
  githubRepo: string;
  techStack: string;
  description?: string;
  status: ProjectStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  model: string;
  status: AgentStatus;
  projectId?: string;
  currentTicket?: string;
  startedAt?: Date;
}

export interface Session {
  id: string;
  agentId: string;
  projectId: string;
  ticketKey: string;
  branch: string;
  worktreePath: string;
  status: SessionStatus;
  tokensUsed: number;
  cost: number;
  startedAt: Date;
  completedAt?: Date;
}

export interface AuditLogEntry {
  id: string;
  projectId?: string;
  action: string;
  actor: string;
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface DORAMetrics {
  deploymentFrequency: number; // merges per day
  leadTime: number; // hours from ticket creation to merge
  changeFailureRate: number; // percentage
  recoveryTime: number; // minutes
}

export interface AgentMetrics {
  successRate: number;
  autoMergeRate: number;
  avgCostPerTicket: number;
  tokensPerStoryPoint: number;
  avgRetries: number;
  utilization: number;
}
