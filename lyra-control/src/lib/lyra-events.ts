/**
 * Lyra Event Bus — decouples all Lyra components via typed events.
 * Uses Node.js EventEmitter for in-process event-driven architecture.
 */

import { EventEmitter } from "events";

// ── Event payload types ─────────────────────────────────────────────

export interface AgentCompletedEvent {
  ticketKey: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  branch: string;
  worktreePath: string;
  summary: string;
  exitCode: number;
}

export interface AgentFailedEvent {
  ticketKey: string;
  projectId: string;
  sessionId: string;
  agentName: string;
  exitCode: number;
  error?: string;
}

export interface GateResultEvent {
  ticketKey: string;
  projectId: string;
  sessionId: string;
  passed: boolean;
  checks: { name: string; passed: boolean; details: string }[];
  reasoning: string;
}

export interface QaAssignedEvent {
  ticketKey: string;
  projectId: string;
  agentName: string;
  prBranch: string;
}

export interface QaResultEvent {
  ticketKey: string;
  projectId: string;
  sessionId: string;
  passed: boolean;
  details: string;
}

export interface PrCreatedEvent {
  ticketKey: string;
  projectId: string;
  prUrl: string;
  branch: string;
}

export interface PrApprovedEvent {
  ticketKey: string;
  projectId: string;
  prUrl: string;
}

export interface SprintUpdatedEvent {
  projectId: string;
  sprintId: string;
  completedPoints: number;
  plannedPoints: number;
}

export interface LyraDecisionEvent {
  projectId: string;
  category: string;
  action: string;
  reasoning: string;
  confidence: number;
}

export interface NotifyEvent {
  projectId?: string;
  severity: "info" | "warning" | "critical";
  title: string;
  body: string;
}

export interface CostUpdateEvent {
  projectId?: string;
  sessionId?: string;
  agentId?: string;
  teamId?: string;
  category: string;
  cost: number;
  syntheticCost: number;
  model: string;
  ticketKey?: string;
  tokens: { prompt: number; completion: number; total: number };
}

export interface FailureAnalyzedEvent {
  projectId: string;
  ticketKey: string;
  analysis: {
    category: string;
    action: string;
    summary: string;
    suggestedFix: string;
    confidence: number;
    reassignTo?: string;
    rootCause?: string;
  };
  actionTaken: string;
}

export interface AppLaunchedEvent {
  projectId: string;
  ports: number[];
}

export interface AppStoppedEvent {
  projectId: string;
}

export interface AppOutputEvent {
  projectId: string;
  line: string;
}

export interface LaunchProgressEvent {
  projectId: string;
  step: "analyzing" | "generating" | "validating" | "fixing" | "success" | "failed";
  attempt?: number;
  maxRetries?: number;
  error?: string;
}

// ── Event map ───────────────────────────────────────────────────────

export interface LyraEventMap {
  "agent:completed": AgentCompletedEvent;
  "agent:failed": AgentFailedEvent;
  "gate:passed": GateResultEvent;
  "gate:failed": GateResultEvent;
  "qa:assigned": QaAssignedEvent;
  "qa:passed": QaResultEvent;
  "qa:failed": QaResultEvent;
  "pr:created": PrCreatedEvent;
  "pr:approved": PrApprovedEvent;
  "sprint:updated": SprintUpdatedEvent;
  "lyra:decision": LyraDecisionEvent;
  "cost:update": CostUpdateEvent;
  "failure:analyzed": FailureAnalyzedEvent;
  "app:launched": AppLaunchedEvent;
  "app:stopped": AppStoppedEvent;
  "app:output": AppOutputEvent;
  "launch:progress": LaunchProgressEvent;
  notify: NotifyEvent;
}

export type LyraEventName = keyof LyraEventMap;

// ── Typed event bus ─────────────────────────────────────────────────

class LyraEventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends LyraEventName>(event: K, data: LyraEventMap[K]): void {
    console.log(`[LyraEvents] ${event}`, JSON.stringify(data).slice(0, 200));
    this.emitter.emit(event, data);
  }

  on<K extends LyraEventName>(
    event: K,
    handler: (data: LyraEventMap[K]) => void | Promise<void>
  ): void {
    this.emitter.on(event, handler);
  }

  off<K extends LyraEventName>(
    event: K,
    handler: (data: LyraEventMap[K]) => void
  ): void {
    this.emitter.off(event, handler);
  }

  once<K extends LyraEventName>(
    event: K,
    handler: (data: LyraEventMap[K]) => void
  ): void {
    this.emitter.once(event, handler);
  }
}

// Singleton instance
export const lyraEvents = new LyraEventBus();
