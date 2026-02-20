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
  lyraEvents.on("app:output", appOutputHandler);
  lyraEvents.on("app:launched", appLaunchedHandler);
  lyraEvents.on("app:stopped", appStoppedHandler);
  lyraEvents.on("failure:analyzed", failureHandler);
  lyraEvents.on("launch:progress", launchProgressHandler);

  // Poll for updates every 5 seconds
  const interval = setInterval(() => {
    try {
      send("dispatcher", getState());
      send("heartbeat", { timestamp: new Date().toISOString() });
    } catch {
      clearInterval(interval);
      lyraEvents.off("cost:update", costHandler);
      lyraEvents.off("app:output", appOutputHandler);
      lyraEvents.off("app:launched", appLaunchedHandler);
      lyraEvents.off("app:stopped", appStoppedHandler);
      lyraEvents.off("failure:analyzed", failureHandler);
      lyraEvents.off("launch:progress", launchProgressHandler);
      close();
    }
  }, 5000);

  // Clean up on disconnect
  const cleanup = setTimeout(() => {
    clearInterval(interval);
    lyraEvents.off("cost:update", costHandler);
    lyraEvents.off("app:output", appOutputHandler);
    lyraEvents.off("app:launched", appLaunchedHandler);
    lyraEvents.off("app:stopped", appStoppedHandler);
    lyraEvents.off("failure:analyzed", failureHandler);
    close();
  }, 30 * 60 * 1000); // 30 min max connection

  void cleanup;

  return sseResponse(stream);
}
