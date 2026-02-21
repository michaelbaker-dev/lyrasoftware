"use client";

import { useState, useEffect, useRef, useCallback } from "react";

/**
 * Client-side hook for listening to Server-Sent Events.
 * Connects to /api/events and listens for named events.
 * Handles reconnection automatically.
 */
export function useSSE<T>(eventName: string): T | null {
  const [data, setData] = useState<T | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource("/api/events");
    esRef.current = es;

    es.addEventListener(eventName, (event) => {
      try {
        const parsed = JSON.parse(event.data) as T;
        setData(parsed);
      } catch {
        // Invalid JSON — skip
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      // Reconnect after 5 seconds
      reconnectTimer.current = setTimeout(connect, 5000);
    };
  }, [eventName]);

  useEffect(() => {
    connect();

    return () => {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };
  }, [connect]);

  return data;
}
