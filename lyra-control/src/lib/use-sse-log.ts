"use client";

import { useState, useEffect, useRef, useCallback } from "react";

/**
 * SSE hook that accumulates events into an array (vs useSSE which replaces state).
 * Useful for streaming log output where each event adds a line.
 */
export function useSSELog<T>(
  eventName: string,
  filter?: (data: T) => boolean
): { lines: T[]; clear: () => void } {
  const [lines, setLines] = useState<T[]>([]);
  const esRef = useRef<EventSource | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => setLines([]), []);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
    }

    const es = new EventSource("/api/events");
    esRef.current = es;

    es.addEventListener(eventName, (event) => {
      try {
        const parsed = JSON.parse(event.data) as T;
        if (filter && !filter(parsed)) return;
        setLines((prev) => [...prev, parsed]);
      } catch {
        // Invalid JSON — skip
      }
    });

    es.onerror = () => {
      es.close();
      esRef.current = null;
      reconnectTimer.current = setTimeout(connect, 5000);
    };
  }, [eventName, filter]);

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

  return { lines, clear };
}
