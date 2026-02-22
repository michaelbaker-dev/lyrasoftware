"use client";

import type { OnboardingData } from "../onboarding-wizard";

type ScaffoldStepProps = {
  data: OnboardingData;
  onNext: () => void;
  onBack?: () => void;
};

export default function ScaffoldStep({ data, onNext, onBack }: ScaffoldStepProps) {
  const files = [
    { name: "CLAUDE.md", desc: "Project-specific Claude Code instructions" },
    { name: "PRD.md", desc: "Product Requirements Document (from Architect)" },
    { name: "ARD.md", desc: "Architecture Decision Record (from Architect)" },
    { name: ".github/workflows/ci.yml", desc: "CI pipeline" },
    { name: ".github/workflows/auto-merge.yml", desc: "Auto-merge on CI pass" },
    { name: ".github/workflows/rollback.yml", desc: "Post-merge smoke test + rollback" },
    { name: ".github/pull_request_template.md", desc: "PR template with Jira link" },
    { name: ".gitignore", desc: "If missing" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-gray-100 mb-2">File Scaffolding</h2>
        <p className="text-gray-400">Preview the files that will be generated. Nothing is written yet — this happens on Execute.</p>
      </div>

      <div className="bg-gray-800 rounded-lg p-6 space-y-3">
        <h3 className="text-lg font-semibold text-gray-100">
          Files to generate ({files.length}):
        </h3>
        <ul className="space-y-1.5 text-gray-300 text-sm">
          {files.map((f) => (
            <li key={f.name} className="flex items-start gap-2">
              <span className="font-mono text-blue-400 shrink-0">{f.name}</span>
              <span className="text-gray-500">— {f.desc}</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-gray-500 mt-3">
          Target: <span className="font-mono">{data.localPath}</span>
        </p>
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
