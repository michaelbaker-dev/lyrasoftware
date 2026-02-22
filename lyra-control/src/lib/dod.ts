/**
 * Definition of Done constants for each work item level.
 * Injected into agent prompts and CLAUDE.md templates.
 */

export const STORY_DOD = [
  "All acceptance criteria from the ticket are met",
  "Tests written and passing for new functionality (skip if the story is pure scaffolding/config with no testable behavior)",
  "Code compiles with no type errors (tsc --noEmit passes)",
  "Commit messages follow conventional commit format with ticket ID",
  "All created/modified files are git committed (run git status to verify nothing is uncommitted)",
  "If all acceptance criteria are already met by existing code, report this in your output — do not create unnecessary commits or changes",
];

/** Build role-aware DoD: architects get a relaxed test requirement for scaffolding stories. */
export function getStoryDod(role?: string): string[] {
  if (role === "architect") {
    return STORY_DOD.filter((item) => !item.startsWith("Tests written"));
  }
  return STORY_DOD;
}

export const EPIC_DOD = [
  "All child stories complete",
  "Integration tests pass across story boundaries",
  "No regressions in existing test suite",
];

export const FEATURE_DOD = [
  "All child epics complete",
  "End-to-end tests pass",
  "Documentation updated if applicable",
];
