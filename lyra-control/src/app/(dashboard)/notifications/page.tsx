"use client";

import { useState, useEffect, useCallback } from "react";
import {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getQueueStats,
} from "./actions";

type Notification = {
  id: string;
  projectId: string | null;
  channel: string;
  severity: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
};

type QueueStats = { pending: number; sent: number; failed: number };

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [stats, setStats] = useState<QueueStats>({ pending: 0, sent: 0, failed: 0 });
  const [filter, setFilter] = useState<"all" | "unread">("unread");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const [notifs, qStats] = await Promise.all([
      getNotifications(filter === "unread"),
      getQueueStats(),
    ]);
    setNotifications(notifs);
    setStats(qStats);
    setLoading(false);
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const handleMarkRead = async (id: string) => {
    await markAsRead(id);
    load();
  };

  const handleMarkAllRead = async () => {
    await markAllAsRead();
    load();
  };

  const severityColor: Record<string, string> = {
    info: "text-blue-400 bg-blue-400/10",
    warning: "text-yellow-400 bg-yellow-400/10",
    critical: "text-red-400 bg-red-400/10",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Notifications</h1>
        <div className="flex items-center gap-3">
          <div className="flex gap-1 rounded-lg border border-gray-800 p-1">
            {(["unread", "all"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded-md px-3 py-1 text-sm ${
                  filter === f
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:text-gray-200"
                }`}
              >
                {f === "unread" ? "Unread" : "All"}
              </button>
            ))}
          </div>
          <button
            onClick={handleMarkAllRead}
            className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-gray-800"
          >
            Mark all read
          </button>
        </div>
      </div>

      {/* Queue stats */}
      <div className="flex gap-4 text-sm">
        <span className="text-gray-500">
          Message Queue: <span className="text-gray-300">{stats.pending}</span> pending,{" "}
          <span className="text-green-400">{stats.sent}</span> sent,{" "}
          <span className="text-red-400">{stats.failed}</span> failed
        </span>
      </div>

      {loading ? (
        <div className="text-gray-400 py-10 text-center">Loading...</div>
      ) : notifications.length === 0 ? (
        <div className="text-gray-500 py-10 text-center">
          {filter === "unread" ? "No unread notifications" : "No notifications yet"}
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map((n) => (
            <div
              key={n.id}
              className={`rounded-xl border p-4 space-y-1 ${
                n.read
                  ? "border-gray-800 bg-gray-900/50"
                  : "border-gray-700 bg-gray-900"
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      severityColor[n.severity] || "text-gray-400"
                    }`}
                  >
                    {n.severity}
                  </span>
                  <span className="text-sm font-medium text-gray-100">
                    {n.title}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                  {!n.read && (
                    <button
                      onClick={() => handleMarkRead(n.id)}
                      className="text-xs text-gray-500 hover:text-gray-300"
                    >
                      Mark read
                    </button>
                  )}
                </div>
              </div>
              <p className="text-sm text-gray-400 whitespace-pre-wrap">
                {n.body}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
