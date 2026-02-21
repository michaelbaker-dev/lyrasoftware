"use client";

import type { OnboardingData } from "../onboarding-wizard";

type LyraTeamStepProps = {
  data: OnboardingData;
  onNext: () => void;
  onBack?: () => void;
};

export default function LyraTeamStep({ data, onNext, onBack }: LyraTeamStepProps) {
  const keyLower = data.jiraKey.toLowerCase();

  const agents = [
    { name: `${keyLower}-dev-1`, role: "Dev", model: "claude-sonnet-4-5" },
    { name: `${keyLower}-dev-2`, role: "Dev", model: "claude-sonnet-4-5" },
    { name: `${keyLower}-qa-1`, role: "QA", model: "claude-sonnet-4-5" },
    { name: `${keyLower}-arch-1`, role: "Architect", model: "claude-opus-4" },
  ];

  const services = [
    { name: "Dispatcher", interval: "Every 15 min", desc: "Polls Jira for To Do tickets, spawns dev agents" },
    { name: "QA Runner", interval: "Every 15 min", desc: "Polls for Code Review tickets, spawns QA agents" },
    { name: "Quality Gate", interval: "On agent completion", desc: "Validates work before PR creation" },
    { name: "Lyra Brain", interval: "On events", desc: "AI decisions for approvals, escalations, retries" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">Team Setup</h2>
        <p className="text-gray-400">Preview agents and Lyra services. Nothing is configured yet — this happens on Execute.</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold text-gray-100 mb-2">Agents to create ({agents.length}):</h3>
          <div className="space-y-1.5">
            {agents.map((a) => (
              <div key={a.name} className="flex items-center gap-3 text-sm">
                <span className="font-mono text-blue-400">{a.name}</span>
                <span className="text-gray-500">{a.role}</span>
                <span className="text-gray-600 text-xs">{a.model}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="border-t border-gray-700 pt-4">
          <h3 className="text-sm font-semibold text-gray-300 mb-2">Lyra Services:</h3>
          <div className="space-y-2">
            {services.map((s) => (
              <div key={s.name} className="flex items-start gap-3 text-sm">
                <span className="text-gray-300 font-medium w-28 shrink-0">{s.name}</span>
                <span className="text-gray-500 text-xs w-32 shrink-0">{s.interval}</span>
                <span className="text-gray-400 text-xs">{s.desc}</span>
              </div>
            ))}
          </div>
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
          onClick={onNext}
          className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors ml-auto"
        >
          Next
        </button>
      </div>
    </div>
  );
}
