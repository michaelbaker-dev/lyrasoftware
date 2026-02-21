/**
 * Team Rebalancer — AI-driven sprint work realignment after team structure changes.
 * Analyzes all active sprint tickets and recommends reassignments to match the new
 * team structure. Labels are additive-only (never removed from Jira tickets).
 */

import { prisma } from "@/lib/db";
import { chat, type ChatCostContext } from "@/lib/openrouter";
import {
  searchIssues,
  updateIssueFields,
  addComment,
  createIssue,
  moveIssuesToSprint,
  getBoardsForProject,
  getSprints,
  extractDependencies,
  type JiraIssue,
} from "@/lib/jira";
import { remember } from "@/lib/lyra-brain";

// ── Types ────────────────────────────────────────────────────────────

export interface TeamSnapshot {
  id: string;
  name: string;
  specialization: string;
  routingLabels: string[];
  routingPriority: number;
  isDefault: boolean;
}

export interface TicketReassignment {
  ticketKey: string;
  summary: string;
  currentLabels: string[];
  currentTeam: string | null;
  recommendedTeam: string;
  addLabels: string[];
  confidence: number;
  reasoning: string;
}

export interface SuggestedStory {
  teamName: string;
  summary: string;
  description: string;
  labels: string[];
  rationale: string;
}

export interface RebalancePlan {
  projectId: string;
  jiraKey: string;
  sprintId: number;
  teamsAfter: TeamSnapshot[];
  reassignments: TicketReassignment[];
  unchanged: string[];
  skippedInProgress: string[];
  newStories: SuggestedStory[];
  warnings: string[];
}

export interface RebalanceResult {
  labelsUpdated: number;
  storiesCreated: string[];
  errors: string[];
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseLabels(json: string | null): string[] {
  if (!json) return [];
  try {
    return JSON.parse(json);
  } catch {
    return [];
  }
}

function matchTicketToTeam(
  ticketLabels: string[],
  ticketComponents: string[],
  teams: TeamSnapshot[]
): TeamSnapshot | null {
  const allTags = [
    ...ticketLabels.map((l) => l.toLowerCase()),
    ...ticketComponents.map((c) => c.toLowerCase()),
  ];

  for (const team of teams) {
    if (team.routingLabels.length === 0) continue;
    const hasMatch = team.routingLabels.some((rl) =>
      allTags.some(
        (tt) =>
          tt.includes(rl.toLowerCase()) || rl.toLowerCase().includes(tt)
      )
    );
    if (hasMatch) return team;
  }
  return null;
}

async function findSprintId(jiraKey: string): Promise<{ sprintId: number | null; sprintState: string | null }> {
  const boards = await getBoardsForProject(jiraKey);
  const boardId = boards?.values?.[0]?.id;
  if (!boardId) return { sprintId: null, sprintState: null };

  // Try active sprint first
  const activeSprints = await getSprints(boardId, "active");
  if (activeSprints?.values?.[0]) {
    return { sprintId: activeSprints.values[0].id, sprintState: "active" };
  }

  // Fall back to future sprint
  const futureSprints = await getSprints(boardId, "future");
  if (futureSprints?.values?.[0]) {
    return { sprintId: futureSprints.values[0].id, sprintState: "future" };
  }

  return { sprintId: null, sprintState: null };
}

// ── Core Functions ───────────────────────────────────────────────────

export function captureTeamSnapshot(
  teams: { id: string; name: string; specialization: string; routingLabels: string | null; routingPriority: number; isDefault: boolean }[]
): TeamSnapshot[] {
  return teams.map((t) => ({
    id: t.id,
    name: t.name,
    specialization: t.specialization,
    routingLabels: parseLabels(t.routingLabels),
    routingPriority: t.routingPriority,
    isDefault: t.isDefault,
  }));
}

export async function analyzeRebalance(
  projectId: string,
  model: string = "openrouter/auto"
): Promise<RebalancePlan> {
  // Load project
  const project = await prisma.project.findUniqueOrThrow({
    where: { id: projectId },
  });
  const jiraKey = project.jiraKey;
  if (!jiraKey) throw new Error("Project has no Jira key configured");

  // Load current teams
  const dbTeams = await prisma.team.findMany({
    where: { projectId, enabled: true },
    orderBy: { routingPriority: "asc" },
  });

  if (dbTeams.length === 0) throw new Error("No enabled teams found");

  const teamsAfter = captureTeamSnapshot(dbTeams);

  // Find sprint (for placing new stories only)
  const { sprintId, sprintState } = await findSprintId(jiraKey);

  // Always query all open project tickets regardless of sprint status
  const jql = `project = ${jiraKey} AND status != Done ORDER BY created DESC`;
  const result = await searchIssues(jql);
  const issues = result?.issues || [];

  if (issues.length === 0) {
    return {
      projectId,
      jiraKey,
      sprintId: sprintId ?? 0,
      teamsAfter,
      reassignments: [],
      unchanged: [],
      skippedInProgress: [],
      newStories: [],
      warnings: ["No open tickets found in this project."],
    };
  }

  // Classify each ticket's current team
  const ticketData: {
    key: string;
    summary: string;
    labels: string[];
    components: string[];
    status: string;
    currentTeam: string | null;
    blockedBy: string[];
    blocks: string[];
  }[] = [];

  for (const issue of issues) {
    const labels: string[] = issue.fields?.labels || [];
    const components: string[] =
      issue.fields?.components?.map(
        (c: { name: string }) => c.name
      ) || [];
    const status: string =
      issue.fields?.status?.statusCategory?.key || issue.fields?.status?.name || "unknown";
    const currentTeam = matchTicketToTeam(labels, components, teamsAfter);
    const deps = extractDependencies(issue as JiraIssue);

    ticketData.push({
      key: issue.key,
      summary: issue.fields?.summary || "",
      labels,
      components,
      status,
      currentTeam: currentTeam?.name ?? null,
      blockedBy: deps.filter((d) => d.type === "is-blocked-by").map((d) => d.key),
      blocks: deps.filter((d) => d.type === "blocks").map((d) => d.key),
    });
  }

  // Separate in-progress tickets
  const inProgressStatuses = ["indeterminate", "In Progress", "In Review"];
  const skippedInProgress: string[] = [];
  const classifiableTickets = ticketData.filter((t) => {
    if (
      inProgressStatuses.some(
        (s) => t.status.toLowerCase() === s.toLowerCase()
      )
    ) {
      skippedInProgress.push(t.key);
      return false;
    }
    return true;
  });

  // Build team descriptions for AI
  const teamDescriptions = teamsAfter
    .map(
      (t) =>
        `- ${t.name} (${t.specialization}): routing labels [${t.routingLabels.join(", ")}]`
    )
    .join("\n");

  // Batch AI classification (10-15 per batch)
  const BATCH_SIZE = 12;
  const allClassifications: {
    ticketKey: string;
    team: string;
    confidence: number;
    reasoning: string;
    addLabels: string[];
  }[] = [];

  const costContext: ChatCostContext = {
    projectId,
    category: "rebalance",
  };

  for (let i = 0; i < classifiableTickets.length; i += BATCH_SIZE) {
    const batch = classifiableTickets.slice(i, i + BATCH_SIZE);
    const ticketList = batch
      .map((t, idx) => {
        let line = `${idx + 1}. ${t.key}: "${t.summary}" (labels: [${t.labels.join(", ")}], components: [${t.components.join(", ")}])`;
        if (t.blockedBy.length > 0) line += ` [BLOCKED BY: ${t.blockedBy.join(", ")}]`;
        if (t.blocks.length > 0) line += ` [BLOCKS: ${t.blocks.join(", ")}]`;
        return line;
      })
      .join("\n");

    const response = await chat(
      [
        {
          role: "system",
          content:
            "You are classifying Jira tickets into teams. Respond ONLY with a valid JSON array. No markdown, no explanation.",
        },
        {
          role: "user",
          content: `Given the team structure below, assign each ticket to the best-fit team.

Teams:
${teamDescriptions}

Tickets:
${ticketList}

Respond with a JSON array of objects for tickets that should CHANGE teams:
[{ "ticketKey": "PROJ-101", "team": "TeamName", "confidence": 0.85, "reasoning": "Brief reason", "addLabels": ["label1"] }]

Rules:
- Only include tickets that should CHANGE from their current team assignment
- "addLabels" should contain the routing label(s) from the recommended team that the ticket doesn't already have
- Confidence should be 0.0-1.0
- If a ticket is fine where it is, OMIT it entirely
- Keep blocking dependencies in mind: if ticket A blocks ticket B, prefer keeping them assigned to teams that can work in the right order
- Return an empty array [] if no changes needed`,
        },
      ],
      model,
      costContext
    );

    const content = response.choices[0]?.message?.content || "[]";
    try {
      const cleaned = content
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        allClassifications.push(...parsed);
      }
    } catch {
      // Skip unparseable batch — will show as warning
    }
  }

  // Build reassignment list
  const reassignments: TicketReassignment[] = [];
  const unchanged: string[] = [];

  for (const ticket of classifiableTickets) {
    const classification = allClassifications.find(
      (c) => c.ticketKey === ticket.key
    );

    if (classification) {
      // Validate the recommended team exists
      const targetTeam = teamsAfter.find(
        (t) => t.name.toLowerCase() === classification.team.toLowerCase()
      );
      if (!targetTeam) continue;

      // Deduplicate addLabels against existing labels
      const existingLower = ticket.labels.map((l) => l.toLowerCase());
      const addLabels = (classification.addLabels || []).filter(
        (l) => !existingLower.includes(l.toLowerCase())
      );

      reassignments.push({
        ticketKey: ticket.key,
        summary: ticket.summary,
        currentLabels: ticket.labels,
        currentTeam: ticket.currentTeam,
        recommendedTeam: targetTeam.name,
        addLabels,
        confidence: classification.confidence ?? 0.5,
        reasoning: classification.reasoning || "",
      });
    } else {
      unchanged.push(ticket.key);
    }
  }

  // Identify teams with zero tickets after classification
  const teamsWithTickets = new Set<string>();
  for (const ticket of ticketData) {
    // Check both current and reassigned team
    const reassignment = reassignments.find(
      (r) => r.ticketKey === ticket.key
    );
    teamsWithTickets.add(
      reassignment?.recommendedTeam?.toLowerCase() ??
        ticket.currentTeam?.toLowerCase() ??
        ""
    );
  }

  const uncoveredTeams = teamsAfter.filter(
    (t) => !t.isDefault && !teamsWithTickets.has(t.name.toLowerCase())
  );

  // Suggest stories for uncovered teams
  let newStories: SuggestedStory[] = [];
  if (uncoveredTeams.length > 0) {
    const uncoveredList = uncoveredTeams
      .map(
        (t) =>
          `- ${t.name} (${t.specialization}): routing labels [${t.routingLabels.join(", ")}]`
      )
      .join("\n");

    try {
      const storyResponse = await chat(
        [
          {
            role: "system",
            content:
              "You are a project manager suggesting Jira stories. Respond ONLY with a valid JSON array. No markdown.",
          },
          {
            role: "user",
            content: `The following teams have NO sprint tickets assigned. Suggest 1-3 stories per team that match their domain.

Project: ${jiraKey}
Teams with no tickets:
${uncoveredList}

Respond with a JSON array:
[{ "teamName": "Security", "summary": "Story title", "description": "Brief description", "labels": ["security"], "rationale": "Why this story matters" }]`,
          },
        ],
        "openrouter/auto",
        costContext
      );

      const storyContent =
        storyResponse.choices[0]?.message?.content || "[]";
      const cleaned = storyContent
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      if (Array.isArray(parsed)) {
        newStories = parsed;
      }
    } catch {
      // Non-fatal — just no suggestions
    }
  }

  const warnings: string[] = [];
  if (!sprintId) {
    warnings.push(
      "No sprint found — new stories will be created in the backlog."
    );
  } else if (sprintState === "future") {
    warnings.push(
      "No active sprint — new stories will be added to the next planned sprint."
    );
  }
  if (skippedInProgress.length > 0) {
    warnings.push(
      `${skippedInProgress.length} in-progress ticket(s) skipped (not reassigned): ${skippedInProgress.join(", ")}`
    );
  }

  return {
    projectId,
    jiraKey,
    sprintId: sprintId ?? 0,
    teamsAfter,
    reassignments,
    unchanged,
    skippedInProgress,
    newStories,
    warnings,
  };
}

export async function executeRebalance(
  plan: RebalancePlan,
  approvedTicketKeys: string[],
  approvedStoryIndices: number[]
): Promise<RebalanceResult> {
  let labelsUpdated = 0;
  const storiesCreated: string[] = [];
  const errors: string[] = [];

  // Apply approved reassignments
  for (const key of approvedTicketKeys) {
    const reassignment = plan.reassignments.find(
      (r) => r.ticketKey === key
    );
    if (!reassignment) continue;

    try {
      // Add labels (additive only — merge with existing)
      if (reassignment.addLabels.length > 0) {
        const allLabels = [
          ...new Set([
            ...reassignment.currentLabels,
            ...reassignment.addLabels,
          ]),
        ];
        await updateIssueFields(key, { labels: allLabels });
      }

      await addComment(
        key,
        `Reassigned to ${reassignment.recommendedTeam} during team rebalance (confidence: ${Math.round(reassignment.confidence * 100)}%). Reason: ${reassignment.reasoning}`
      );
      labelsUpdated++;
    } catch (e) {
      errors.push(
        `Failed to update ${key}: ${(e as Error).message}`
      );
    }
  }

  // Create approved new stories
  for (const idx of approvedStoryIndices) {
    const story = plan.newStories[idx];
    if (!story) continue;

    try {
      const issue = await createIssue(
        plan.jiraKey,
        "Story",
        story.summary,
        story.description
      );

      const issueKey = issue?.key;
      if (issueKey) {
        // Set routing labels on the new issue
        if (story.labels.length > 0) {
          await updateIssueFields(issueKey, { labels: story.labels });
        }

        // Move to sprint
        if (plan.sprintId) {
          await moveIssuesToSprint(plan.sprintId, [issueKey]);
        }

        storiesCreated.push(issueKey);
      }
    } catch (e) {
      errors.push(
        `Failed to create story "${story.summary}": ${(e as Error).message}`
      );
    }
  }

  // Audit log
  await prisma.auditLog.create({
    data: {
      projectId: plan.projectId,
      action: "team.rebalanced",
      actor: "user",
      details: JSON.stringify({
        labelsUpdated,
        storiesCreated,
        errors: errors.length,
        teamsAfter: plan.teamsAfter.map((t) => t.name),
      }),
    },
  });

  // Remember the decision
  await remember(plan.projectId, "decision", {
    type: "team_rebalance",
    labelsUpdated,
    storiesCreated,
    reassignments: plan.reassignments
      .filter((r) => approvedTicketKeys.includes(r.ticketKey))
      .map((r) => ({
        ticket: r.ticketKey,
        from: r.currentTeam,
        to: r.recommendedTeam,
      })),
  });

  return { labelsUpdated, storiesCreated, errors };
}
