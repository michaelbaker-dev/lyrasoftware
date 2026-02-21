/**
 * Definition of Done constants for each work item level.
 * Injected into agent prompts and CLAUDE.md templates.
 */

export const STORY_DOD = [
  "All acceptance criteria from the ticket are met",
  "Tests written and passing for new functionality",
  "Code compiles with no type errors (tsc --noEmit passes)",
  "Commit messages follow conventional commit format with ticket ID",
  "PR created with description linking to the Jira ticket",
  "If all acceptance criteria are already met by existing code, report this in your output — do not create unnecessary commits or changes",
];

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
