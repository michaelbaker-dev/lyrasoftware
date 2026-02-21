/**
 * PI (Program Increment) Planner — quarterly planning across sprints.
 * Analyzes full backlog, groups into themes, plans 5-6 sprints.
 */

import { prisma } from "./db";
import { chat } from "./openrouter";
import { searchIssues } from "./jira";
import { remember } from "./lyra-brain";

export interface PIRoadmap {
  piName: string;
  themes: { name: string; description: string; epicKeys: string[] }[];
  sprints: {
    number: number;
    goal: string;
    stories: string[];
    estimatedPoints: number;
  }[];
  dependencies: { from: string; to: string; type: string }[];
  risks: string[];
}

export async function generatePIPlan(projectId: string): Promise<PIRoadmap> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });

  if (!project) throw new Error("Project not found");

  // Get full backlog
  const backlogResult = await searchIssues(
    `project = ${project.jiraKey} AND status != Done ORDER BY rank ASC`
  );
  const issues = backlogResult.issues || [];

  // Get velocity history
  const sprints = await prisma.sprint.findMany({
    where: { projectId, state: "closed" },
    orderBy: { endDate: "desc" },
    take: 6,
  });

  const avgVelocity =
    sprints.length > 0
      ? Math.round(
          sprints.reduce((sum, s) => sum + s.completedPoints, 0) /
            sprints.length
        )
      : project.velocityTarget;

  const issueData = issues.map((i) => ({
    key: i.key,
    summary: i.fields.summary,
    type: i.fields.issuetype?.name,
    status: i.fields.status?.name,
  }));

  const response = await chat(
    [
      {
        role: "system",
        content: `You are Lyra, an AI Scrum Master. Generate a Program Increment (PI) plan spanning 5-6 sprints.
Return ONLY valid JSON matching this schema:
{
  "piName": "string",
  "themes": [{ "name": "string", "description": "string", "epicKeys": ["PROJ-1"] }],
  "sprints": [{ "number": 1, "goal": "string", "stories": ["PROJ-2"], "estimatedPoints": 20 }],
  "dependencies": [{ "from": "PROJ-1", "to": "PROJ-2", "type": "blocks" }],
  "risks": ["string"]
}`,
      },
      {
        role: "user",
        content: [
          `Project: ${project.name} (${project.jiraKey})`,
          `Average Velocity: ${avgVelocity} pts/sprint`,
          `Sprint Length: ${project.sprintLength} days`,
          "",
          `Backlog (${issueData.length} items):`,
          JSON.stringify(issueData.slice(0, 100), null, 2),
        ].join("\n"),
      },
    ],
    "openrouter/auto"
  );

  const raw = response.choices[0]?.message?.content || "{}";
  let roadmap: PIRoadmap;
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, raw];
    roadmap = JSON.parse(jsonMatch[1]!.trim());
  } catch {
    roadmap = {
      piName: `PI ${new Date().toISOString().slice(0, 7)}`,
      themes: [],
      sprints: [],
      dependencies: [],
      risks: ["Failed to generate PI plan — manual planning needed"],
    };
  }

  await remember(projectId, "decision", {
    type: "pi_planning",
    piName: roadmap.piName,
    sprintCount: roadmap.sprints.length,
    themeCount: roadmap.themes.length,
  });

  return roadmap;
}
