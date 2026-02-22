"use client";

import { useState } from "react";
import { deleteProject, type DeleteResult } from "./actions";
import { useRouter } from "next/navigation";

type Props = {
  projectId: string;
  projectName: string;
  jiraKey: string;
  githubRepo: string | null;
  existingRepo: string | null;
  compact?: boolean;
};

export default function DeleteButton({
  projectId,
  projectName,
  jiraKey,
  githubRepo,
  existingRepo,
  compact = false,
}: Props) {
  const router = useRouter();
  const [showDialog, setShowDialog] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DeleteResult | null>(null);

  const handleDelete = async () => {
    setRunning(true);
    const res = await deleteProject(projectId);
    setResult(res);
    setRunning(false);
    // Don't auto-redirect — let user read the results and click "Done"
  };

  const handleDone = () => {
    router.push("/projects");
    router.refresh();
  };

  const stepStatusIcon = (status: string) => {
    if (status === "success") return "\u2705";
    if (status === "failed") return "\u274C";
    return "\u23ED\uFE0F";
  };

  if (compact) {
    return (
      <>
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setShowDialog(true);
          }}
          className="rounded p-1.5 text-gray-500 hover:bg-red-900/30 hover:text-red-400 transition-colors"
          title="Delete project"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
            <path fillRule="evenodd" d="M8.75 1A2.75 2.75 0 006 3.75v.443c-.795.077-1.584.176-2.365.298a.75.75 0 10.23 1.482l.149-.022.841 10.518A2.75 2.75 0 007.596 19h4.807a2.75 2.75 0 002.742-2.53l.841-10.519.149.023a.75.75 0 00.23-1.482A41.03 41.03 0 0014 4.193V3.75A2.75 2.75 0 0011.25 1h-2.5zM10 4c.84 0 1.673.025 2.5.075V3.75c0-.69-.56-1.25-1.25-1.25h-2.5c-.69 0-1.25.56-1.25 1.25v.325C8.327 4.025 9.16 4 10 4zM8.58 7.72a.75.75 0 00-1.5.06l.3 7.5a.75.75 0 101.5-.06l-.3-7.5zm4.34.06a.75.75 0 10-1.5-.06l-.3 7.5a.75.75 0 101.5.06l.3-7.5z" clipRule="evenodd" />
          </svg>
        </button>

        {showDialog && (
          <Dialog
            projectName={projectName}
            jiraKey={jiraKey}
            githubRepo={githubRepo}
            existingRepo={existingRepo}
            confirmText={confirmText}
            setConfirmText={setConfirmText}
            running={running}
            result={result}
            onConfirm={handleDelete}
            onCancel={() => { setShowDialog(false); setConfirmText(""); setResult(null); }}
            onDone={handleDone}
          />
        )}
      </>
    );
  }

  return (
    <>
      <button
        onClick={() => setShowDialog(true)}
        className="rounded-lg border border-red-800 bg-red-900/20 px-4 py-2 text-sm font-medium text-red-400 hover:bg-red-900/40 transition-colors"
      >
        Delete Project
      </button>

      {showDialog && (
        <Dialog
          projectName={projectName}
          jiraKey={jiraKey}
          githubRepo={githubRepo}
          existingRepo={existingRepo}
          confirmText={confirmText}
          setConfirmText={setConfirmText}
          running={running}
          result={result}
          onConfirm={handleDelete}
          onCancel={() => { setShowDialog(false); setConfirmText(""); setResult(null); }}
          onDone={handleDone}
        />
      )}
    </>
  );
}

function Dialog({
  projectName,
  jiraKey,
  githubRepo,
  existingRepo,
  confirmText,
  setConfirmText,
  running,
  result,
  onConfirm,
  onCancel,
  onDone,
}: {
  projectName: string;
  jiraKey: string;
  githubRepo: string | null;
  existingRepo: string | null;
  confirmText: string;
  setConfirmText: (v: string) => void;
  running: boolean;
  result: DeleteResult | null;
  onConfirm: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  const stepStatusIcon = (status: string) => {
    if (status === "success") return "\u2705";
    if (status === "failed") return "\u274C";
    return "\u23ED\uFE0F";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onCancel}>
      <div className="w-full max-w-lg rounded-xl border border-gray-700 bg-gray-900 p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-red-400">Delete Project: {projectName}</h2>

        {!result && (
          <>
            <div className="mt-4 space-y-2 text-sm">
              <p className="text-gray-300 font-medium">This will delete:</p>
              <ul className="list-disc pl-5 text-gray-400 space-y-1">
                <li>Jira project & all issues: <span className="text-gray-200">{jiraKey}</span></li>
                <li>All database records (agents, sessions, sprints, logs)</li>
              </ul>

              <p className="text-gray-300 font-medium mt-3">This will NOT delete:</p>
              <ul className="list-disc pl-5 text-gray-400 space-y-1">
                <li>Source code on disk</li>
                {githubRepo && (
                  <li>GitHub repository: <span className="text-gray-200">{githubRepo}</span></li>
                )}
              </ul>
            </div>

            <div className="mt-5">
              <label className="block text-sm text-gray-400 mb-1.5">
                Type <span className="font-mono font-bold text-gray-200">{jiraKey}</span> to confirm:
              </label>
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-200 focus:border-red-500 focus:outline-none"
                placeholder={jiraKey}
                disabled={running}
                autoFocus
              />
            </div>

            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={onCancel}
                className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
                disabled={running}
              >
                Cancel
              </button>
              <button
                onClick={onConfirm}
                disabled={confirmText !== jiraKey || running}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {running ? "Deleting..." : "Delete Project"}
              </button>
            </div>
          </>
        )}

        {result && (
          <>
            <div className="mt-4 space-y-3 max-h-80 overflow-y-auto">
              {result.steps.map((step, i) => (
                <div key={i} className="rounded-lg bg-gray-800 p-3">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span>{stepStatusIcon(step.status)}</span>
                    <span className="text-gray-200">{step.name}</span>
                    <span className={`ml-auto text-xs ${
                      step.status === "success" ? "text-green-400" :
                      step.status === "failed" ? "text-red-400" : "text-gray-500"
                    }`}>
                      {step.status}
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-0.5">
                    {step.logs.map((log, j) => (
                      <p key={j} className="text-xs text-gray-500 font-mono">{log}</p>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {result.success ? (
              <div className="mt-4 flex items-center justify-between">
                {result.steps.some((s) => s.status === "failed") ? (
                  <p className="text-sm text-yellow-400">
                    Project removed from Lyra (some external cleanup failed — see above)
                  </p>
                ) : (
                  <p className="text-sm text-green-400">
                    Project deleted successfully
                  </p>
                )}
                <button
                  onClick={onDone}
                  className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-gray-600"
                >
                  Done
                </button>
              </div>
            ) : (
              <div className="mt-4 flex items-center justify-between">
                <p className="text-sm text-red-400">{result.error}</p>
                <button
                  onClick={onCancel}
                  className="rounded-lg bg-gray-700 px-4 py-2 text-sm font-medium text-gray-200 hover:bg-gray-600"
                >
                  Close
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
