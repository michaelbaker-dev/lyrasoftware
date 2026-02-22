"use client";

import { useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { getCeremonyHistory, getProjects, triggerStandup } from "./actions";

type CeremonyEntry = {
  id: string;
  category: string;
  content: string;
  createdAt: string;
  projectName?: string;
};

type Project = { id: string; name: string };

export default function CeremoniesPage() {
  const [entries, setEntries] = useState<CeremonyEntry[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const projectId = searchParams.get("project") || undefined;

  const load = useCallback(async () => {
    const [data, projectList] = await Promise.all([
      getCeremonyHistory(projectId),
      getProjects(),
    ]);
    setEntries(data);
    setProjects(projectList);
    setLoading(false);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleProjectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set("project", value);
    } else {
      params.delete("project");
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const handleTriggerStandup = async () => {
    setTriggering(true);
    await triggerStandup();
    setTriggering(false);
    load();
  };

  const categoryLabels: Record<string, string> = {
    observation: "Daily Standup",
    reflection: "Sprint Review / Retro",
    decision: "Decision",
  };

  const categoryColors: Record<string, string> = {
    observation: "text-blue-400 bg-blue-400/10",
    reflection: "text-purple-400 bg-purple-400/10",
    decision: "text-green-400 bg-green-400/10",
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Ceremonies</h1>
          <p className="mt-1 text-gray-400">
            Standup reports, sprint reviews, and retrospectives
          </p>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={projectId || ""}
            onChange={handleProjectChange}
            className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-1.5 text-sm"
          >
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            onClick={handleTriggerStandup}
            disabled={triggering}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {triggering ? "Generating..." : "Run Standup Now"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-gray-400 py-10 text-center">Loading...</div>
      ) : entries.length === 0 ? (
        <div className="text-gray-500 py-10 text-center">
          No ceremony history yet. Ceremonies will appear here after Lyra starts running.
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map((entry) => {
            let parsed: Record<string, unknown> = {};
            try {
              parsed = JSON.parse(entry.content);
            } catch {
              // content is not JSON
            }

            const type = (parsed.type as string) || entry.category;
            const summary =
              (parsed.summary as string) ||
              (parsed.review as string) ||
              (parsed.retro as string) ||
              (parsed.analysis as string) ||
              entry.content;

            return (
              <div
                key={entry.id}
                className="rounded-xl border border-gray-800 bg-gray-900 p-5 space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                        categoryColors[entry.category] || "text-gray-400"
                      }`}
                    >
                      {categoryLabels[entry.category] || entry.category}
                    </span>
                    {type !== entry.category && (
                      <span className="text-xs text-gray-500">{type}</span>
                    )}
                    {entry.projectName && (
                      <span className="text-xs text-gray-500">
                        {entry.projectName}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-500">
                    {new Date(entry.createdAt).toLocaleString()}
                  </span>
                </div>
                <div className="text-sm text-gray-300 whitespace-pre-wrap">
                  {typeof summary === "string"
                    ? summary
                    : JSON.stringify(summary, null, 2)}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
