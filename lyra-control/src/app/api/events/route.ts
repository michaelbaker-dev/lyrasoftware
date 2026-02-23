import { createSSEStream, sseResponse } from "@/lib/sse";
import { getState } from "@/lib/dispatcher";
import {
  lyraEvents,
  type CostUpdateEvent,
  type AppOutputEvent,
  type AppLaunchedEvent,
  type AppStoppedEvent,
  type FailureAnalyzedEvent,
  type LaunchProgressEvent,
  type AgentOutputEvent,
  type GateResultEvent,
  type AgentCompletedEvent,
  type AgentFailedEvent,
  type TicketAbandonedEvent,
  type LyraDecisionEvent,
  type NotifyEvent,
  type LyraThinkingEvent,
} from "@/lib/lyra-events";

export async function GET() {
  const { stream, send, close } = createSSEStream();

  // Send initial state
  send("dispatcher", getState());

  // Listen for cost:update events and forward to SSE clients
  const costHandler = (data: CostUpdateEvent) => {
    try {
      send("cost:update", data);
    } catch {
      // Client disconnected — will be cleaned up below
    }
  };
  lyraEvents.on("cost:update", costHandler);

  // Listen for app process events
  const appOutputHandler = (data: AppOutputEvent) => {
    try {
      send("app:output", data);
    } catch {
      // Client disconnected
    }
  };
  const appLaunchedHandler = (data: AppLaunchedEvent) => {
    try {
      send("app:launched", data);
    } catch {
      // Client disconnected
    }
  };
  const appStoppedHandler = (data: AppStoppedEvent) => {
    try {
      send("app:stopped", data);
    } catch {
      // Client disconnected
    }
  };
  const failureHandler = (data: FailureAnalyzedEvent) => {
    try {
      send("failure:analyzed", data);
    } catch {
      // Client disconnected
    }
  };
  const launchProgressHandler = (data: LaunchProgressEvent) => {
    try {
      send("launch:progress", data);
    } catch {
      // Client disconnected
    }
  };
  const agentOutputHandler = (data: AgentOutputEvent) => {
    try {
      send("agent:output", data);
    } catch {
      // Client disconnected
    }
  };
  // Pipeline-related event handlers
  const gatePassedHandler = (data: GateResultEvent) => {
    try { send("gate:passed", data); } catch { /* disconnected */ }
  };
  const gateFailedHandler = (data: GateResultEvent) => {
    try { send("gate:failed", data); } catch { /* disconnected */ }
  };
  const agentCompletedHandler = (data: AgentCompletedEvent) => {
    try { send("agent:completed", data); } catch { /* disconnected */ }
  };
  const agentFailedHandler = (data: AgentFailedEvent) => {
    try { send("agent:failed", data); } catch { /* disconnected */ }
  };
  const ticketAbandonedHandler = (data: TicketAbandonedEvent) => {
    try { send("ticket:abandoned", data); } catch { /* disconnected */ }
  };
  const lyraDecisionHandler = (data: LyraDecisionEvent) => {
    try { send("lyra:decision", data); } catch { /* disconnected */ }
  };
  const notifyHandler = (data: NotifyEvent) => {
    try { send("notify", data); } catch { /* disconnected */ }
  };
  const thinkingHandler = (data: LyraThinkingEvent) => {
    try { send("lyra:thinking", data); } catch { /* disconnected */ }
  };

  lyraEvents.on("agent:output", agentOutputHandler);
  lyraEvents.on("app:output", appOutputHandler);
  lyraEvents.on("app:launched", appLaunchedHandler);
  lyraEvents.on("app:stopped", appStoppedHandler);
  lyraEvents.on("failure:analyzed", failureHandler);
  lyraEvents.on("launch:progress", launchProgressHandler);
  lyraEvents.on("gate:passed", gatePassedHandler);
  lyraEvents.on("gate:failed", gateFailedHandler);
  lyraEvents.on("agent:completed", agentCompletedHandler);
  lyraEvents.on("agent:failed", agentFailedHandler);
  lyraEvents.on("ticket:abandoned", ticketAbandonedHandler);
  lyraEvents.on("lyra:decision", lyraDecisionHandler);
  lyraEvents.on("notify", notifyHandler);
  lyraEvents.on("lyra:thinking", thinkingHandler);

  // Poll for updates every 5 seconds
  const interval = setInterval(() => {
    try {
      send("dispatcher", getState());
      send("heartbeat", { timestamp: new Date().toISOString() });
    } catch {
      clearInterval(interval);
      lyraEvents.off("cost:update", costHandler);
      lyraEvents.off("agent:output", agentOutputHandler);
      lyraEvents.off("app:output", appOutputHandler);
      lyraEvents.off("app:launched", appLaunchedHandler);
      lyraEvents.off("app:stopped", appStoppedHandler);
      lyraEvents.off("failure:analyzed", failureHandler);
      lyraEvents.off("launch:progress", launchProgressHandler);
      lyraEvents.off("gate:passed", gatePassedHandler);
      lyraEvents.off("gate:failed", gateFailedHandler);
      lyraEvents.off("agent:completed", agentCompletedHandler);
      lyraEvents.off("agent:failed", agentFailedHandler);
      lyraEvents.off("ticket:abandoned", ticketAbandonedHandler);
      lyraEvents.off("lyra:decision", lyraDecisionHandler);
      lyraEvents.off("notify", notifyHandler);
      lyraEvents.off("lyra:thinking", thinkingHandler);
      close();
    }
  }, 5000);

  // Clean up on disconnect
  const cleanup = setTimeout(() => {
    clearInterval(interval);
    lyraEvents.off("cost:update", costHandler);
    lyraEvents.off("agent:output", agentOutputHandler);
    lyraEvents.off("app:output", appOutputHandler);
    lyraEvents.off("app:launched", appLaunchedHandler);
    lyraEvents.off("app:stopped", appStoppedHandler);
    lyraEvents.off("failure:analyzed", failureHandler);
    lyraEvents.off("launch:progress", launchProgressHandler);
    lyraEvents.off("gate:passed", gatePassedHandler);
    lyraEvents.off("gate:failed", gateFailedHandler);
    lyraEvents.off("agent:completed", agentCompletedHandler);
    lyraEvents.off("agent:failed", agentFailedHandler);
    lyraEvents.off("ticket:abandoned", ticketAbandonedHandler);
    lyraEvents.off("lyra:decision", lyraDecisionHandler);
    lyraEvents.off("notify", notifyHandler);
    lyraEvents.off("lyra:thinking", thinkingHandler);
    close();
  }, 30 * 60 * 1000); // 30 min max connection

  void cleanup;

  return sseResponse(stream);
}
