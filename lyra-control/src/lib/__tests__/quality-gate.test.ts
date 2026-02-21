import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("child_process", () => ({
  execFile: vi.fn(),
}));

vi.mock("fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
}));

vi.mock("../db", () => ({
  prisma: {
    qualityGateRun: { create: vi.fn(async () => ({})) },
  },
}));

vi.mock("../lyra-events", () => ({
  lyraEvents: { emit: vi.fn() },
}));

vi.mock("../lyra-brain", () => ({
  decide: vi.fn(),
  validateAcceptanceCriteria: vi.fn(),
}));

import { execFile } from "child_process";
import { runQualityGate } from "../quality-gate";
import { decide, validateAcceptanceCriteria } from "../lyra-brain";
import { lyraEvents } from "../lyra-events";

const mockedExecFile = vi.mocked(execFile);
const mockedDecide = vi.mocked(decide);
const mockedValidateAC = vi.mocked(validateAcceptanceCriteria);
const mockedEmit = vi.mocked(lyraEvents.emit);

// Helper: make execFile's promisified form resolve/reject
function mockExec(stdout: string) {
  mockedExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb?: Function) => {
      if (cb) {
        cb(null, { stdout, stderr: "" });
      }
      return undefined as never;
    }
  );
}

function mockExecSequence(results: { stdout: string }[]) {
  let callIndex = 0;
  mockedExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb?: Function) => {
      const result = results[callIndex++] ?? { stdout: "" };
      if (cb) {
        cb(null, { stdout: result.stdout, stderr: "" });
      }
      return undefined as never;
    }
  );
}

const baseParams = {
  sessionId: "sess-1",
  ticketKey: "LYRA-42",
  projectId: "proj-1",
  worktreePath: "/tmp/worktree",
  baseBranch: "main",
  acceptanceCriteria: ["Feature X works correctly"],
  agentOutput: "I verified feature X is already implemented.",
  summary: "Agent found feature X already present",
};

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Tests ────────────────────────────────────────────────────────────

describe("runQualityGate — already-done path", () => {
  it("returns alreadyDone=true when zero commits, AC passes, and Lyra approves", async () => {
    // git log returns empty (no commits), git diff returns empty
    mockExecSequence([{ stdout: "" }, { stdout: "" }]);

    mockedValidateAC.mockResolvedValue({
      passed: true,
      details: "All criteria met by existing code",
      criteriaResults: [
        { criterion: "Feature X works correctly", met: true, explanation: "Already implemented" },
      ],
    });

    mockedDecide.mockResolvedValue({
      action: "approve",
      reasoning: "AC met without code changes — already done",
      confidence: 0.9,
      details: {},
    });

    const result = await runQualityGate(baseParams);

    expect(result.passed).toBe(true);
    expect(result.alreadyDone).toBe(true);
    expect(result.checks).toHaveLength(2); // commits + AC only
    expect(result.checks[0].name).toBe("Branch has commits");
    expect(result.checks[0].passed).toBe(false);
    expect(result.checks[1].name).toBe("Acceptance criteria");
    expect(result.checks[1].passed).toBe(true);
    expect(mockedEmit).toHaveBeenCalledWith("gate:passed", expect.objectContaining({ passed: true }));
  });

  it("returns passed=false when zero commits, AC passes, but Lyra rejects", async () => {
    mockExecSequence([{ stdout: "" }, { stdout: "" }]);

    mockedValidateAC.mockResolvedValue({
      passed: true,
      details: "Criteria appear met",
      criteriaResults: [
        { criterion: "Feature X works correctly", met: true, explanation: "Present" },
      ],
    });

    mockedDecide.mockResolvedValue({
      action: "reject",
      reasoning: "Not confident the feature truly works",
      confidence: 0.4,
      details: {},
    });

    const result = await runQualityGate(baseParams);

    expect(result.passed).toBe(false);
    expect(result.alreadyDone).toBe(false);
    expect(result.reasoning).toBe("No commits and acceptance criteria not met on base branch");
    expect(mockedEmit).toHaveBeenCalledWith("gate:failed", expect.objectContaining({ passed: false }));
  });

  it("returns passed=false when zero commits and AC fails", async () => {
    mockExecSequence([{ stdout: "" }, { stdout: "" }]);

    mockedValidateAC.mockResolvedValue({
      passed: false,
      details: "Criteria not met",
      criteriaResults: [
        { criterion: "Feature X works correctly", met: false, explanation: "Not found in codebase" },
      ],
    });

    const result = await runQualityGate(baseParams);

    expect(result.passed).toBe(false);
    expect(result.alreadyDone).toBe(false);
    expect(result.reasoning).toContain("No commits and acceptance criteria not met");
    // decide should NOT have been called — AC failed
    expect(mockedDecide).not.toHaveBeenCalled();
  });
});

describe("runQualityGate — normal path with commits", () => {
  it("returns passed=true, alreadyDone=false when all checks pass", async () => {
    // git log (commits), tsc, tests, git diff (for AC)
    mockExecSequence([
      { stdout: "abc1234 feat: add feature X\n" }, // git log — has commits
      { stdout: "" },                               // tsc --noEmit (success)
      { stdout: "all tests passed" },                // npm test
      { stdout: "diff --git a/foo.ts b/foo.ts\n" }, // git diff for AC
    ]);

    mockedValidateAC.mockResolvedValue({
      passed: true,
      details: "All criteria met",
      criteriaResults: [
        { criterion: "Feature X works correctly", met: true, explanation: "Implemented" },
      ],
    });

    mockedDecide.mockResolvedValue({
      action: "approve",
      reasoning: "All checks passed",
      confidence: 0.95,
      details: {},
    });

    const result = await runQualityGate(baseParams);

    expect(result.passed).toBe(true);
    expect(result.alreadyDone).toBe(false);
    expect(result.checks).toHaveLength(4); // commits, tsc, tests, AC
    expect(mockedEmit).toHaveBeenCalledWith("gate:passed", expect.objectContaining({ passed: true }));
  });
});
