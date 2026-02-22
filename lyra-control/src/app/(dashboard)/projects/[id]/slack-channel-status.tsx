"use client";

import { useState } from "react";
import { retrySlackSetup } from "./team-actions";

export default function SlackChannelStatus({
  projectId,
  channelId,
  jiraKey,
}: {
  projectId: string;
  channelId: string | null;
  jiraKey: string;
}) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    success: boolean;
    channelName?: string;
    error?: string;
  } | null>(null);

  async function handleRetry() {
    setLoading(true);
    setResult(null);
    try {
      const res = await retrySlackSetup(projectId);
      setResult(res);
    } catch (e) {
      setResult({ success: false, error: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  const channelName = `lyra-${jiraKey.toLowerCase()}`;
  const hasChannel = Boolean(channelId) || result?.success;

  return (
    <div>
      <dt className="text-gray-500">Slack Channel</dt>
      <dd className="mt-0.5 flex items-center gap-2">
        {hasChannel ? (
          <span className="font-medium text-green-400">#{channelName}</span>
        ) : (
          <span className="font-medium text-gray-600">Not configured</span>
        )}
        <button
          onClick={handleRetry}
          disabled={loading}
          className="rounded bg-gray-700 px-2 py-0.5 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-50"
        >
          {loading
            ? "Working..."
            : hasChannel
              ? "Re-invite Me"
              : "Setup Channel"}
        </button>
      </dd>
      {result && (
        <p className={`mt-1 text-xs ${result.success ? "text-green-400" : "text-red-400"}`}>
          {result.success
            ? `Channel #${result.channelName} ready — you should now see it in Slack`
            : result.error}
          {result.success && result.error && (
            <span className="text-yellow-400"> ({result.error})</span>
          )}
        </p>
      )}
    </div>
  );
}
