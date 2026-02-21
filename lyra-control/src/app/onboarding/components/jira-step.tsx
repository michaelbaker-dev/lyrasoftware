"use client";

import { useState } from "react";
import { saveJiraDescription } from "../actions";
import type { OnboardingData } from "../onboarding-wizard";

type JiraStepProps = {
  data: OnboardingData;
  onChange?: (data: OnboardingData) => void;
  onNext: () => void;
  onBack?: () => void;
};

export default function JiraStep({ data, onChange, onNext, onBack }: JiraStepProps) {
  const [description, setDescription] = useState(
    data.description || data.vision.split("\n")[0].slice(0, 200)
  );

  const handleNext = async () => {
    // Save description to DB if changed
    if (description !== data.description) {
      await saveJiraDescription(data.jiraKey, description);
      if (onChange) {
        onChange({ ...data, description });
      }
    }
    onNext();
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">Jira Project</h2>
        <p className="text-gray-400">Review the Jira project configuration. Nothing is created yet — this is just a preview.</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 space-y-3">
        <h3 className="text-lg font-semibold text-gray-100">Will be created on Execute:</h3>
        <ul className="space-y-1 text-gray-300 text-sm">
          <li>Jira project: <span className="font-mono text-blue-400">{data.jiraKey}</span> ({data.projectName})</li>
          <li>Custom fields: Agent Team, Agent Status, Worktree Branch, Cost</li>
          <li>Workflow: Backlog &rarr; To Do &rarr; In Progress &rarr; Code Review &rarr; QA &rarr; QA Passed &rarr; Done</li>
        </ul>
      </div>

      <div>
        <label htmlFor="jiraDescription" className="block text-sm font-medium text-gray-300 mb-2">
          Project Description
        </label>
        <textarea
          id="jiraDescription"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          className="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-transparent resize-none"
          placeholder="Short description for the Jira project"
        />
        <p className="mt-1 text-xs text-gray-500">This description will be used when creating the Jira project.</p>
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
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors ml-auto"
        >
          Next
        </button>
      </div>
    </div>
  );
}
