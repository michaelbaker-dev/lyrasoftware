/**
 * Release Notes Generator — AI writes grouped release notes from sprint data.
 * Wraps output with Handlebars template for consistent formatting.
 */

import { chat } from "./openrouter";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Handlebars from "handlebars";
import type { DemoTicket } from "./sprint-demo-data";

export async function generateReleaseNotes(input: {
  projectId: string;
  sprintId: string;
  sprintName: string;
  sprintGoal?: string | null;
  tickets: DemoTicket[];
  totals: { completed: number; failed: number; cost: number; gatePassRate: number };
  projectPath: string;
  projectName: string;
  runCmd: string;
}): Promise<{ markdown: string; filePath: string }> {
  // Ask AI to write release notes content
  const response = await chat(
    [
      {
        role: "system",
        content: `You are writing release notes for a software sprint. Write clear, professional release notes in markdown format.

Structure your output with these sections:
## What Was Built
Group completed tickets by feature area. Write 1-2 sentences per group explaining what was delivered.

## Quality Summary
Brief overview of quality gate results and testing outcomes.

## Known Issues
List any failed tickets or known problems. If none, say "No known issues."

## How to Run
Provide the exact command to launch the application.

Do NOT include a title heading — that's handled by the template.
Write in past tense. Be concise and factual.`,
      },
      {
        role: "user",
        content: `Sprint: ${input.sprintName}
Goal: ${input.sprintGoal || "N/A"}
Run command: cd ${input.projectPath} && ${input.runCmd}

Tickets:
${input.tickets
  .map(
    (t) =>
      `- ${t.key}: ${t.summary} [${t.status}] Gate: ${t.gatePassed === null ? "N/A" : t.gatePassed ? "PASSED" : "FAILED"} Agent: ${t.agent}`
  )
  .join("\n")}

Totals: ${input.totals.completed} completed, ${input.totals.failed} failed, ${input.totals.gatePassRate}% gate pass rate`,
      },
    ],
    "openrouter/auto",
    { projectId: input.projectId, category: "release-notes" }
  );

  const aiContent = response.choices[0]?.message?.content || "";

  // Wrap with template
  const templatePath = join(
    process.cwd(),
    "src",
    "templates",
    "release-notes.md.hbs"
  );
  const templateSource = readFileSync(templatePath, "utf-8");
  const template = Handlebars.compile(templateSource);

  const markdown = template({
    sprintName: input.sprintName,
    sprintGoal: input.sprintGoal,
    date: new Date().toISOString().split("T")[0],
    aiContent,
    totals: input.totals,
    totalCost: input.totals.cost.toFixed(2),
    projectName: input.projectName,
  });

  // Write to project directory
  const safeName = input.sprintName.replace(/[^a-zA-Z0-9_-]/g, "-");
  const filePath = join(input.projectPath, `RELEASE-${safeName}.md`);
  writeFileSync(filePath, markdown, "utf-8");

  return { markdown, filePath };
}
