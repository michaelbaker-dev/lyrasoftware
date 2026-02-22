"use client";

import { useState } from "react";
import { saveGitHubConfig, saveProjectGitHubToken } from "../actions";
import type { OnboardingData } from "../onboarding-wizard";

type GitHubStepProps = {
  data: OnboardingData;
  onChange?: (data: OnboardingData) => void;
  onNext: () => void;
  onBack?: () => void;
};

export default function GitHubStep({ data, onChange, onNext, onBack }: GitHubStepProps) {
  const [mode, setMode] = useState<"create" | "existing">(data.githubMode);
  const [repoUrl, setRepoUrl] = useState(data.existingRepo || "");
  const [githubToken, setGithubToken] = useState("");
  const [showToken, setShowToken] = useState(false);

  const repoName = data.projectName.toLowerCase().replace(/\s+/g, "-");

  const handleModeChange = (newMode: "create" | "existing") => {
    setMode(newMode);
    if (onChange) {
      onChange({ ...data, githubMode: newMode });
    }
  };

  const handleNext = async () => {
    // Save config to DB
    await saveGitHubConfig(data.jiraKey, mode, mode === "existing" ? repoUrl : undefined);

    // Save per-project GitHub token if provided
    if (githubToken.trim()) {
      await saveProjectGitHubToken(data.jiraKey, githubToken.trim());
    }

    if (onChange && mode === "existing") {
      onChange({ ...data, existingRepo: repoUrl, githubMode: mode });
    }

    onNext();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">GitHub Repository</h2>
        <p className="text-gray-400">Choose how to set up the GitHub repo. Nothing is created yet — this is just configuration.</p>
      </div>

      {/* Mode selector */}
      <div className="flex gap-3">
        <button
          onClick={() => handleModeChange("create")}
          className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-colors cursor-pointer ${
            mode === "create"
              ? "border-blue-500 bg-blue-500/10 text-blue-400"
              : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
          }`}
        >
          Create New Repo
        </button>
        <button
          onClick={() => handleModeChange("existing")}
          className={`flex-1 px-4 py-3 rounded-lg border text-sm font-medium transition-colors cursor-pointer ${
            mode === "existing"
              ? "border-blue-500 bg-blue-500/10 text-blue-400"
              : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-600"
          }`}
        >
          Use Existing Repo
        </button>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 space-y-3">
        {mode === "create" ? (
          <>
            <h3 className="text-lg font-semibold text-gray-100">Will be created on Execute:</h3>
            <ul className="space-y-1 text-gray-300 text-sm">
              <li>Private repo: michaelbaker-dev/{repoName}</li>
              <li>Branch protection on main (require CI, require PR, no force push)</li>
              <li>0 approvals required (agents auto-merge via CI)</li>
            </ul>
          </>
        ) : (
          <>
            <h3 className="text-lg font-semibold text-gray-100">Will be verified on Execute:</h3>
            <ul className="space-y-1 text-gray-300 text-sm">
              <li>Verify repo exists and is accessible</li>
              <li>Link repo to this project in database</li>
              <li>Set branch protection on main (if not already set)</li>
            </ul>
            <div className="mt-3">
              <label htmlFor="repoUrl" className="block text-sm font-medium text-gray-300 mb-2">
                Repository URL
              </label>
              <input
                id="repoUrl"
                type="text"
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                className="w-full px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent"
                placeholder="https://github.com/org/repo"
              />
            </div>
          </>
        )}
      </div>

      {/* Optional per-project GitHub token */}
      <div className="bg-gray-800 rounded-lg p-4">
        <label htmlFor="githubToken" className="block text-sm font-medium text-gray-300 mb-1">
          GitHub Token (Optional)
        </label>
        <p className="text-xs text-gray-500 mb-2">
          If this project uses a different GitHub org or needs its own PAT, enter it here.
          Otherwise, the default token from Settings or <code className="text-gray-400">gh</code> CLI auth will be used.
        </p>
        <div className="flex gap-2">
          <input
            id="githubToken"
            type={showToken ? "text" : "password"}
            value={githubToken}
            onChange={(e) => setGithubToken(e.target.value)}
            className="flex-1 px-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent text-sm"
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
          />
          <button
            type="button"
            onClick={() => setShowToken(!showToken)}
            className="px-3 py-2 border border-gray-700 rounded-lg text-sm text-gray-400 hover:text-gray-200 hover:bg-gray-700 transition-colors"
          >
            {showToken ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      <div className="flex justify-between">
        {onBack && (
          <button
            onClick={onBack}
            className="px-6 py-2 bg-gray-700 hover:bg-gray-600 text-white font-medium rounded-lg transition-colors"
          >
            Back
          </button>
        )}
        <button
          onClick={handleNext}
          disabled={mode === "existing" && !repoUrl.trim()}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors ml-auto"
        >
          Next
        </button>
      </div>
    </div>
  );
}
