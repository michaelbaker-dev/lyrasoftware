/**
 * Jira REST API v3 client for Lyra Control.
 * Handles project creation, ticket management, workflow transitions, and comments.
 * Credentials loaded from database settings, falling back to env vars.
 */

import { prisma } from "./db";

const JIRA_BASE_URL_DEFAULT = "https://mbakers.atlassian.net";

export async function getBaseUrl(): Promise<string> {
  const setting = await prisma.setting.findUnique({
    where: { key: "jira_base_url" },
  });
  return setting?.value || JIRA_BASE_URL_DEFAULT;
}

async function getCredentials(): Promise<{ email: string; token: string }> {
  const settings = await prisma.setting.findMany({
    where: { key: { in: ["jira_email", "jira_api_token"] } },
  });
  const email =
    settings.find((s) => s.key === "jira_email")?.value ||
    process.env.JIRA_EMAIL ||
    "";
  const token =
    settings.find((s) => s.key === "jira_api_token")?.value ||
    process.env.JIRA_API_TOKEN ||
    "";
  return { email, token };
}

async function authHeaders(): Promise<HeadersInit> {
  const { email, token } = await getCredentials();
  if (!email || !token) {
    throw new Error(
      "Jira credentials not configured. Set them in Settings > API Keys."
    );
  }
  const encoded = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    Authorization: `Basic ${encoded}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function jiraFetch(path: string, options: RequestInit = {}) {
  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}/rest/api/3${path}`;
  const headers = await authHeaders();
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jira API error ${response.status}: ${body}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JiraIssue = Record<string, any> & {
  id: string;
  key: string;
  fields: Record<string, any>;
};

export async function createProject(key: string, name: string, description?: string) {
  // Get lead account ID from current user
  const myself = await jiraFetch("/myself");
  return jiraFetch("/project", {
    method: "POST",
    body: JSON.stringify({
      key,
      name,
      description: description || "",
      projectTypeKey: "software",
      projectTemplateKey: "com.pyxis.greenhopper.jira:gh-scrum-template",
      leadAccountId: myself.accountId,
    }),
  });
}

export async function createIssue(
  projectKey: string,
  issueType: "Epic" | "Story" | "Bug" | "Task" | "Subtask",
  summary: string,
  description?: string,
  parentKey?: string
) {
  return jiraFetch("/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        issuetype: { name: issueType },
        summary,
        ...(parentKey && { parent: { key: parentKey } }),
        ...(description && {
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: description }],
              },
            ],
          },
        }),
      },
    }),
  });
}

export async function createIssueWithAdf(
  projectKey: string,
  issueType: "Epic" | "Story" | "Bug" | "Task" | "Subtask",
  summary: string,
  descriptionAdf: object
) {
  return jiraFetch("/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: projectKey },
        issuetype: { name: issueType },
        summary,
        description: descriptionAdf,
      },
    }),
  });
}

export async function transitionIssue(
  issueKey: string,
  transitionId: string
) {
  return jiraFetch(`/issue/${issueKey}/transitions`, {
    method: "POST",
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
}

export async function addComment(issueKey: string, body: string) {
  return jiraFetch(`/issue/${issueKey}/comment`, {
    method: "POST",
    body: JSON.stringify({
      body: {
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: body }],
          },
        ],
      },
    }),
  });
}

export async function searchIssues(jql: string, maxResults: number = 50): Promise<{ issues: JiraIssue[]; total: number }> {
  // The /search/jql endpoint requires explicit fields and uses nextPageToken
  // (not startAt) for pagination. Without fields, issues only contain { id }.
  const allIssues: JiraIssue[] = [];
  let nextPageToken: string | undefined;

  do {
    const body: Record<string, unknown> = {
      jql,
      maxResults: Math.min(maxResults - allIssues.length, 50),
      fields: [
        "summary",
        "status",
        "labels",
        "components",
        "description",
        "issuetype",
        "priority",
        "assignee",
        "issuelinks",
      ],
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const result = await jiraFetch("/search/jql", {
      method: "POST",
      body: JSON.stringify(body),
    });

    const issues = result?.issues || [];
    allIssues.push(...issues);
    nextPageToken = result?.isLast === false ? result.nextPageToken : undefined;
  } while (nextPageToken && allIssues.length < maxResults);

  return { issues: allIssues, total: allIssues.length };
}

export async function getTransitions(issueKey: string) {
  return jiraFetch(`/issue/${issueKey}/transitions`);
}

export async function getFields() {
  return jiraFetch("/field");
}

export async function deleteIssue(issueKey: string) {
  return jiraFetch(`/issue/${issueKey}`, { method: "DELETE" });
}

export async function getIssue(issueKey: string) {
  return jiraFetch(`/issue/${issueKey}`);
}

/** Soft-delete (trash) a Jira project */
export async function deleteProject(projectKey: string) {
  return jiraFetch(`/project/${projectKey}/delete`, { method: "POST" });
}

/** Delete all issues in a project via JQL search + batch delete */
export async function deleteAllProjectIssues(projectKey: string): Promise<{ deleted: number; failed: number }> {
  let deleted = 0;
  let failed = 0;
  const maxResults = 50;

  // Always search from 0 since we're deleting results each iteration
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await searchIssues(`project = "${projectKey}" ORDER BY created DESC`, maxResults);
    const issues = result?.issues || [];
    if (issues.length === 0) break;

    for (const issue of issues) {
      try {
        await deleteIssue(issue.key);
        deleted++;
      } catch {
        failed++;
      }
    }
  }

  return { deleted, failed };
}

/** Test Jira connection by fetching current user */
export async function testConnection(): Promise<{ ok: boolean; user?: string; error?: string }> {
  try {
    const myself = await jiraFetch("/myself");
    return { ok: true, user: myself.displayName };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// ── Jira Agile REST API (`/rest/agile/1.0`) ─────────────────────────

async function jiraAgileFetch(path: string, options: RequestInit = {}) {
  const baseUrl = await getBaseUrl();
  const url = `${baseUrl}/rest/agile/1.0${path}`;
  const headers = await authHeaders();
  const response = await fetch(url, {
    ...options,
    headers: { ...headers, ...options.headers },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jira Agile API error ${response.status}: ${body}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

export async function getBoardsForProject(projectKey: string) {
  return jiraAgileFetch(`/board?projectKeyOrId=${encodeURIComponent(projectKey)}&type=scrum`);
}

export async function createSprint(data: {
  name: string;
  startDate?: string;
  endDate?: string;
  originBoardId: number;
  goal?: string;
}) {
  return jiraAgileFetch("/sprint", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getSprints(boardId: number, state?: string) {
  const qs = state ? `?state=${encodeURIComponent(state)}` : "";
  return jiraAgileFetch(`/board/${boardId}/sprint${qs}`);
}

export async function getSprintIssues(sprintId: number) {
  return jiraAgileFetch(`/sprint/${sprintId}/issue`);
}

export async function moveIssuesToSprint(sprintId: number, issueKeys: string[]) {
  return jiraAgileFetch(`/sprint/${sprintId}/issue`, {
    method: "POST",
    body: JSON.stringify({ issues: issueKeys }),
  });
}

export async function updateSprint(sprintId: number, data: Record<string, unknown>) {
  return jiraAgileFetch(`/sprint/${sprintId}`, {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function rankIssues(issueKeys: string[], rankBeforeIssue?: string) {
  const body: Record<string, unknown> = { issues: issueKeys };
  if (rankBeforeIssue) body.rankBeforeIssue = rankBeforeIssue;
  return jiraAgileFetch("/issue/rank", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function getBacklog(boardId: number) {
  return jiraAgileFetch(`/board/${boardId}/backlog`);
}

export async function updateIssueFields(issueKey: string, fields: Record<string, unknown>) {
  return jiraFetch(`/issue/${issueKey}`, {
    method: "PUT",
    body: JSON.stringify({ fields }),
  });
}

let _storyPointsFieldId: string | null = null;
let _epicLinkFieldId: string | null = null;

export async function getStoryPointsFieldId(): Promise<string | null> {
  if (_storyPointsFieldId) return _storyPointsFieldId;
  const fields = await getFields();
  const sp = fields.find(
    (f: { name: string; id: string }) =>
      f.name === "Story Points" || f.name === "Story point estimate"
  );
  _storyPointsFieldId = sp?.id || null;
  return _storyPointsFieldId;
}

export async function getEpicLinkFieldId(): Promise<string | null> {
  if (_epicLinkFieldId) return _epicLinkFieldId;
  const fields = await getFields();
  const el = fields.find(
    (f: { name: string; id: string }) =>
      f.name === "Epic Link" || f.name === "Parent Link"
  );
  _epicLinkFieldId = el?.id || null;
  return _epicLinkFieldId;
}

// ── Issue linking ─────────────────────────────────────────────────────

/**
 * Link two Jira issues together (e.g., Bug "is caused by" Story).
 * Uses Jira REST API POST /rest/api/3/issueLink.
 */
export async function linkIssues(
  inwardKey: string,
  outwardKey: string,
  linkType: string = "Blocks"
): Promise<void> {
  await jiraFetch("/issueLink", {
    method: "POST",
    body: JSON.stringify({
      type: { name: linkType },
      inwardIssue: { key: inwardKey },
      outwardIssue: { key: outwardKey },
    }),
  });
}

// ── Dependency extraction ─────────────────────────────────────────────

export interface IssueDependency {
  key: string;
  type: "blocks" | "is-blocked-by";
  status: string;          // status category key (e.g., "done", "new", "indeterminate")
  statusName: string;      // actual status name (e.g., "Code Review", "In Progress", "Done")
  summary: string;
}

/**
 * Extract blocking dependencies from a Jira issue's issuelinks field.
 * Returns which issues this ticket blocks and which block it.
 */
export function extractDependencies(issue: JiraIssue): IssueDependency[] {
  const links = issue.fields?.issuelinks;
  if (!Array.isArray(links)) return [];

  const deps: IssueDependency[] = [];

  for (const link of links) {
    const typeName = (link.type?.name || "").toLowerCase();

    // "Blocks" link type: outwardIssue = this blocks that, inwardIssue = that blocks this
    if (typeName === "blocks") {
      if (link.outwardIssue) {
        deps.push({
          key: link.outwardIssue.key,
          type: "blocks",
          status: link.outwardIssue.fields?.status?.statusCategory?.key || "unknown",
          statusName: link.outwardIssue.fields?.status?.name || "",
          summary: link.outwardIssue.fields?.summary || "",
        });
      }
      if (link.inwardIssue) {
        deps.push({
          key: link.inwardIssue.key,
          type: "is-blocked-by",
          status: link.inwardIssue.fields?.status?.statusCategory?.key || "unknown",
          statusName: link.inwardIssue.fields?.status?.name || "",
          summary: link.inwardIssue.fields?.summary || "",
        });
      }
    }

    // "Dependency" / "depends on" link type (used by some Jira configs)
    if (typeName === "dependency" || typeName === "depends on") {
      if (link.outwardIssue) {
        deps.push({
          key: link.outwardIssue.key,
          type: "blocks",
          status: link.outwardIssue.fields?.status?.statusCategory?.key || "unknown",
          statusName: link.outwardIssue.fields?.status?.name || "",
          summary: link.outwardIssue.fields?.summary || "",
        });
      }
      if (link.inwardIssue) {
        deps.push({
          key: link.inwardIssue.key,
          type: "is-blocked-by",
          status: link.inwardIssue.fields?.status?.statusCategory?.key || "unknown",
          statusName: link.inwardIssue.fields?.status?.name || "",
          summary: link.inwardIssue.fields?.summary || "",
        });
      }
    }
  }

  return deps;
}
