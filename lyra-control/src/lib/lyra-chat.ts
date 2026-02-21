/**
 * Lyra Chat — persistent conversational AI (per-project + general).
 * Manages chat history, token budgets, automatic summarization,
 * and Jira action execution for the general channel.
 * Uses OpenRouter for all chat calls to preserve Claude Max budget.
 */

import { chat, type ChatMessage as OpenRouterMessage } from "./openrouter";
import { getPersonalityTemplate, getContext } from "./lyra-brain";
import { prisma } from "./db";
import * as jira from "./jira";
import { isTavilyConfigured, searchWeb, formatSearchResultsForPrompt } from "./tavily";

// ── Token budget tiers ─────────────────────────────────────────────
const TOKEN_BUDGET = {
  system: 800,
  projectSummary: 300,
  memories: 1_500,
  conversation: 6_000,
  userMessage: 500,
  total: 9_000,
};

const MAX_CONVERSATION_MESSAGES = 40;
const SUMMARIZE_THRESHOLD = 40;
const SUMMARIZE_BATCH = 20;

// ── Token estimation ───────────────────────────────────────────────

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateMessagesTokens(
  messages: { role: string; content: string }[]
): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

// ── Trim conversation to budget ────────────────────────────────────

export function trimToTokenBudget(
  messages: { role: string; content: string }[],
  maxTokens: number
): { role: string; content: string }[] {
  // Always keep system messages (summaries)
  const systemMsgs = messages.filter((m) => m.role === "system");
  const convMsgs = messages.filter((m) => m.role !== "system");

  const systemTokens = estimateMessagesTokens(systemMsgs);
  let remaining = maxTokens - systemTokens;

  // Take as many recent conversation messages as fit
  const kept: { role: string; content: string }[] = [];
  for (let i = convMsgs.length - 1; i >= 0; i--) {
    const tokens = estimateTokens(convMsgs[i].content) + 4;
    if (remaining - tokens < 0) break;
    remaining -= tokens;
    kept.unshift(convMsgs[i]);
  }

  return [...systemMsgs, ...kept];
}

// ── Build chat context ─────────────────────────────────────────────

export async function buildChatContext(
  projectId: string
): Promise<OpenRouterMessage[]> {
  // Layer 1: System prompt (personality)
  const template = getPersonalityTemplate();

  // Layer 2: Project summary
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      name: true,
      jiraKey: true,
      techStack: true,
      velocityTarget: true,
      sprintLength: true,
      status: true,
    },
  });

  const projectContext = project
    ? `Project: ${project.name} (${project.jiraKey}), Tech: ${project.techStack || "N/A"}, Status: ${project.status}, Velocity Target: ${project.velocityTarget} pts/sprint, Sprint Length: ${project.sprintLength} days`
    : undefined;

  // Layer 3: Recent memories
  const memories = await getContext(projectId, 10);
  const recentMemory = memories.map((m) => ({
    category: m.category,
    content:
      typeof m.content === "string"
        ? m.content.slice(0, 200)
        : JSON.stringify(m.content).slice(0, 200),
  }));

  const systemPrompt = template({ projectContext, recentMemory });

  // Layer 4: Conversation window
  const chatMessages = await prisma.chatMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: "asc" },
    take: MAX_CONVERSATION_MESSAGES,
    select: { role: true, content: true },
  });

  // Trim conversation to fit token budget
  const trimmedConv = trimToTokenBudget(
    chatMessages,
    TOKEN_BUDGET.conversation
  );

  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: [
        systemPrompt,
        "",
        "You are chatting with the Product Owner in the Lyra Control app.",
        "Be conversational, helpful, and concise. Reference project context when relevant.",
        "If asked about sprint status, tickets, or metrics, use your memory and project context to answer.",
      ].join("\n"),
    },
    ...trimmedConv.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    })),
  ];

  return messages;
}

// ── Web search helper ──────────────────────────────────────────────

function looksLikeSearchQuery(msg: string): boolean {
  const lower = msg.toLowerCase();
  const triggers = [
    "what is", "how to", "how do", "compare", "vs ", "latest", "news",
    "recommend", "best practice", "alternative", "difference between", "should i use",
  ];
  return triggers.some((t) => lower.includes(t)) || (msg.includes("?") && msg.length > 20);
}

// ── Main chat function ─────────────────────────────────────────────

export async function chatWithLyra(
  projectId: string,
  userMessage: string,
  useWebSearch?: boolean
): Promise<string> {
  // Save user message
  await prisma.chatMessage.create({
    data: { projectId, role: "user", content: userMessage },
  });

  // Check if summarization is needed before building context
  const messageCount = await prisma.chatMessage.count({
    where: { projectId },
  });
  if (messageCount > SUMMARIZE_THRESHOLD) {
    await summarizeOldMessages(projectId);
  }

  // Build context and call LLM
  const messages = await buildChatContext(projectId);
  messages.push({ role: "user", content: userMessage });

  // Optionally enrich with web research
  if (useWebSearch && (await isTavilyConfigured()) && looksLikeSearchQuery(userMessage)) {
    const webResults = await searchWeb(userMessage, {
      maxResults: 3,
      searchDepth: "basic",
      projectId,
      category: "chat",
    });
    messages.splice(-1, 0, {
      role: "system",
      content: formatSearchResultsForPrompt(webResults),
    });
  }

  const startMs = Date.now();
  const response = await chat(messages, "openrouter/auto");
  const durationMs = Date.now() - startMs;

  const assistantContent =
    response.choices[0]?.message?.content || "I couldn't generate a response.";

  // Save assistant response
  await prisma.chatMessage.create({
    data: { projectId, role: "assistant", content: assistantContent },
  });

  // Log usage
  await prisma.aiUsageLog.create({
    data: {
      projectId,
      document: "chat",
      provider: "openrouter",
      requestedModel: "openrouter/auto",
      actualModel: response.model || "openrouter/auto",
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
      cost: response.usage?.cost || 0,
      durationMs,
      tokensPerSecond: durationMs > 0
        ? ((response.usage?.completion_tokens || 0) / (durationMs / 1000))
        : 0,
    },
  });

  return assistantContent;
}

// ── Summarize old messages ─────────────────────────────────────────

export async function summarizeOldMessages(
  projectId: string
): Promise<void> {
  const oldMessages = await prisma.chatMessage.findMany({
    where: {
      projectId,
      role: { not: "system" },
    },
    orderBy: { createdAt: "asc" },
    take: SUMMARIZE_BATCH,
  });

  if (oldMessages.length < SUMMARIZE_BATCH) return;

  // Check if these aren't already summary messages
  const hasNonSummary = oldMessages.some((m) => {
    if (!m.metadata) return true;
    try {
      const meta = JSON.parse(m.metadata);
      return meta.type !== "summary";
    } catch {
      return true;
    }
  });
  if (!hasNonSummary) return;

  const conversationText = oldMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const summaryResponse = await chat(
    [
      {
        role: "system",
        content:
          "Summarize this conversation concisely. Capture key decisions, questions asked, and important context. Keep it under 300 words.",
      },
      { role: "user", content: conversationText },
    ],
    "openrouter/auto"
  );

  const summary =
    summaryResponse.choices[0]?.message?.content || "Conversation summary.";

  // Store summary as system message
  await prisma.chatMessage.create({
    data: {
      projectId,
      role: "system",
      content: `[Conversation Summary] ${summary}`,
      metadata: JSON.stringify({
        type: "summary",
        summarizedCount: oldMessages.length,
        summarizedRange: {
          from: oldMessages[0].createdAt.toISOString(),
          to: oldMessages[oldMessages.length - 1].createdAt.toISOString(),
        },
      }),
    },
  });

  // Delete summarized messages
  await prisma.chatMessage.deleteMany({
    where: {
      id: { in: oldMessages.map((m) => m.id) },
    },
  });
}

// ── Get recent messages for UI ─────────────────────────────────────

export async function getRecentMessages(
  projectId: string,
  limit: number = 20
) {
  return prisma.chatMessage.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      role: true,
      content: true,
      metadata: true,
      createdAt: true,
    },
  });
}

// ════════════════════════════════════════════════════════════════════
// General Chat (cross-project, #lyra-general, Jira actions)
// ════════════════════════════════════════════════════════════════════

const GENERAL_CHAT_PROJECT_ID = "__general__";

const GENERAL_TOKEN_BUDGET = {
  system: 1_500,
  projects: 1_000,
  memories: 1_500,
  conversation: 5_500,
  userMessage: 500,
  total: 10_000,
};

// ── Action system prompt ──────────────────────────────────────────

const ACTION_INSTRUCTIONS = `
## Actions You Can Take
When the user asks you to do something in Jira, include ACTION blocks in your response.
The system will execute them and append the real results. Format:

[ACTION:create_issue projectKey="PROJ" type="Bug" summary="Login page crashes on mobile" description="Optional details"]
[ACTION:create_issue projectKey="PROJ" type="Story" summary="Add dark mode support"]
[ACTION:create_issue projectKey="PROJ" type="Task" summary="Update CI pipeline"]
[ACTION:search_issues jql="project = PROJ AND status = 'In Progress'" ]
[ACTION:update_issue issueKey="PROJ-42" fields={"priority":{"name":"High"}}]
[ACTION:transition_issue issueKey="PROJ-42" status="In Progress"]
[ACTION:add_comment issueKey="PROJ-42" body="Marking as high priority per PO request"]
[ACTION:get_issue issueKey="PROJ-42"]
[ACTION:delete_issue issueKey="PROJ-42"]
[ACTION:triage_bug issueKey="PROJ-42"]

When you create a Bug issue via create_issue, ALSO include a triage_bug action with the new issue key so it gets analyzed and assigned automatically:
  [ACTION:create_issue projectKey="PROJ" type="Bug" summary="..."]
  [ACTION:triage_bug issueKey="PROJ-42"]

CRITICAL rules for actions:
- ONLY use [ACTION:...] blocks to perform Jira operations. The system executes them and appends real results.
- NEVER write your own result messages like ":white_check_mark: Transitioned..." or ":white_check_mark: Created..." — those come ONLY from the system after execution.
- NEVER claim an action succeeded or describe its outcome. You do NOT know the result until the system executes it.
- Before the ACTION block, briefly explain what you INTEND to do (e.g., "Let me move that to Done for you."). Stop there. Do NOT predict the result.
- You can include multiple ACTION blocks in one response.
- Only take actions when explicitly asked or when it's clearly the right thing to do.
- For ambiguous requests, confirm with the user before acting.
- Use the project's jiraKey (from the project list above) for projectKey.
- If you want to verify an action worked, include a follow-up [ACTION:get_issue issueKey="..."] — do NOT assume success.
`;

// ── Build general chat context ────────────────────────────────────

async function buildGeneralChatContext(): Promise<OpenRouterMessage[]> {
  const template = getPersonalityTemplate();

  // Load ALL active projects
  const projects = await prisma.project.findMany({
    where: { status: "active" },
    select: {
      id: true,
      name: true,
      jiraKey: true,
      techStack: true,
      status: true,
      velocityTarget: true,
      sprintLength: true,
      description: true,
      activeSprintId: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  const allProjects = projects.map((p) => ({
    name: p.name,
    jiraKey: p.jiraKey,
    techStack: p.techStack || "N/A",
    status: p.status,
    velocityTarget: p.velocityTarget,
    sprintLength: p.sprintLength,
    description: p.description || "",
  }));

  // Load recent memories across ALL projects (plus global)
  const memories = await prisma.lyraMemory.findMany({
    orderBy: { createdAt: "desc" },
    take: 15,
    select: { category: true, content: true },
  });
  const recentMemory = memories.map((m) => ({
    category: m.category,
    content:
      typeof m.content === "string"
        ? m.content.slice(0, 200)
        : JSON.stringify(m.content).slice(0, 200),
  }));

  const systemPrompt = template({ allProjects, recentMemory });

  // Load general conversation window
  const chatMessages = await prisma.chatMessage.findMany({
    where: { projectId: null },
    orderBy: { createdAt: "asc" },
    take: MAX_CONVERSATION_MESSAGES,
    select: { role: true, content: true },
  });

  const trimmedConv = trimToTokenBudget(
    chatMessages,
    GENERAL_TOKEN_BUDGET.conversation
  );

  const messages: OpenRouterMessage[] = [
    {
      role: "system",
      content: [
        systemPrompt,
        "",
        "You are chatting with Mike, the Product Owner, in #lyra-general on Slack.",
        "You have full context on all active projects and can discuss any of them.",
        "You can brainstorm, answer questions, give status updates, help prioritize, and take actions in Jira.",
        "Be conversational and warm — this is a collaboration, not a status report.",
        "When referencing projects, use their Jira key (e.g., LYRA, PROJ).",
        ACTION_INSTRUCTIONS,
      ].join("\n"),
    },
    ...trimmedConv.map((m) => ({
      role: m.role as "user" | "assistant" | "system",
      content: m.content,
    })),
  ];

  return messages;
}

// ── Parse and execute actions ─────────────────────────────────────

interface ParsedAction {
  type: string;
  params: Record<string, string>;
}

function parseActions(text: string): ParsedAction[] {
  const actionRegex = /\[ACTION:(\w+)\s+([^\]]+)\]/g;
  const actions: ParsedAction[] = [];
  let match;

  while ((match = actionRegex.exec(text)) !== null) {
    const type = match[1];
    const rawParams = match[2];
    const params: Record<string, string> = {};

    // Parse key="value" and key={json} pairs
    const paramRegex = /(\w+)=(?:"([^"]*)"|\{([^}]*)\}|(\S+))/g;
    let paramMatch;
    while ((paramMatch = paramRegex.exec(rawParams)) !== null) {
      const key = paramMatch[1];
      const value = paramMatch[2] ?? (paramMatch[3] ? `{${paramMatch[3]}}` : paramMatch[4]);
      params[key] = value;
    }

    actions.push({ type, params });
  }

  return actions;
}

async function executeAction(action: ParsedAction): Promise<string> {
  try {
    switch (action.type) {
      case "create_issue": {
        const { projectKey, type, summary, description } = action.params;
        if (!projectKey || !type || !summary) {
          return `:warning: Missing required params for create_issue (need projectKey, type, summary)`;
        }
        const issueType = type as "Epic" | "Story" | "Bug" | "Task" | "Subtask";
        const result = await jira.createIssue(projectKey, issueType, summary, description);
        return `:white_check_mark: Created *${result.key}*: ${summary}`;
      }

      case "search_issues": {
        const { jql } = action.params;
        if (!jql) return `:warning: Missing jql param for search_issues`;
        const result = await jira.searchIssues(jql, 10);
        const issues = result?.issues || [];
        if (issues.length === 0) return `No issues found for: \`${jql}\``;
        const lines = issues.map(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (i: any) => `- *${i.key}*: ${i.fields?.summary} [${i.fields?.status?.name}]`
        );
        return `Found ${result.total} issues (showing ${issues.length}):\n${lines.join("\n")}`;
      }

      case "update_issue": {
        const { issueKey, fields: fieldsStr } = action.params;
        if (!issueKey || !fieldsStr) {
          return `:warning: Missing issueKey or fields for update_issue`;
        }
        const fields = JSON.parse(fieldsStr);
        await jira.updateIssueFields(issueKey, fields);
        return `:white_check_mark: Updated *${issueKey}*`;
      }

      case "transition_issue": {
        const { issueKey, status } = action.params;
        if (!issueKey || !status) {
          return `:warning: Missing issueKey or status for transition_issue`;
        }
        // Find the transition ID by name
        const transitions = await jira.getTransitions(issueKey);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const target = transitions.transitions?.find((t: any) =>
          t.name.toLowerCase().includes(status.toLowerCase())
        );
        if (!target) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const available = transitions.transitions?.map((t: any) => t.name).join(", ");
          return `:warning: No transition matching "${status}" for ${issueKey}. Available: ${available}`;
        }
        await jira.transitionIssue(issueKey, target.id);

        // Verify the transition actually took effect
        const issue = await jira.getIssue(issueKey);
        const actualStatus = issue.fields?.status?.name;
        if (actualStatus?.toLowerCase() !== target.name.toLowerCase()) {
          return `:warning: Transition to "${target.name}" was sent but ${issueKey} is still "${actualStatus}". Check workflow rules.`;
        }

        return `:white_check_mark: Transitioned *${issueKey}* to *${target.name}*`;
      }

      case "add_comment": {
        const { issueKey, body } = action.params;
        if (!issueKey || !body) {
          return `:warning: Missing issueKey or body for add_comment`;
        }
        await jira.addComment(issueKey, body);
        return `:white_check_mark: Added comment to *${issueKey}*`;
      }

      case "get_issue": {
        const { issueKey } = action.params;
        if (!issueKey) return `:warning: Missing issueKey for get_issue`;
        const issue = await jira.getIssue(issueKey);
        const f = issue.fields;
        return [
          `*${issue.key}*: ${f.summary}`,
          `Type: ${f.issuetype?.name} | Status: ${f.status?.name} | Priority: ${f.priority?.name}`,
          f.assignee ? `Assignee: ${f.assignee.displayName}` : "Unassigned",
          f.description?.content?.[0]?.content?.[0]?.text
            ? `> ${f.description.content[0].content[0].text.slice(0, 300)}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
      }

      case "delete_issue": {
        const { issueKey } = action.params;
        if (!issueKey) {
          return `:warning: Missing issueKey for delete_issue`;
        }
        await jira.deleteIssue(issueKey);
        return `:white_check_mark: Deleted *${issueKey}*`;
      }

      case "triage_bug": {
        const { issueKey } = action.params;
        if (!issueKey) {
          return `:warning: Missing issueKey for triage_bug`;
        }
        const { triageSlackBug } = await import("./failure-analyzer");
        const analysis = await triageSlackBug({ issueKey });
        if (analysis) {
          return `:mag: Triaged *${issueKey}*: ${analysis.category} — ${analysis.summary}`;
        }
        return `:warning: Triage completed for *${issueKey}* but no analysis returned`;
      }

      default:
        return `:warning: Unknown action type: ${action.type}`;
    }
  } catch (e) {
    return `:x: Action failed (${action.type}): ${(e as Error).message.slice(0, 200)}`;
  }
}

// ── Main general chat function ────────────────────────────────────

export async function chatWithLyraGeneral(
  userMessage: string,
  useWebSearch?: boolean
): Promise<string> {
  // Save user message (null projectId = general)
  await prisma.chatMessage.create({
    data: { projectId: null, role: "user", content: userMessage },
  });

  // Check if summarization is needed
  const messageCount = await prisma.chatMessage.count({
    where: { projectId: null },
  });
  if (messageCount > SUMMARIZE_THRESHOLD) {
    await summarizeGeneralMessages();
  }

  // Build context and call LLM
  const messages = await buildGeneralChatContext();
  messages.push({ role: "user", content: userMessage });

  // Optionally enrich with web research
  if (useWebSearch && (await isTavilyConfigured()) && looksLikeSearchQuery(userMessage)) {
    const webResults = await searchWeb(userMessage, {
      maxResults: 3,
      searchDepth: "basic",
      category: "chat-general",
    });
    messages.splice(-1, 0, {
      role: "system",
      content: formatSearchResultsForPrompt(webResults),
    });
  }

  const startMs = Date.now();
  const response = await chat(messages, "openrouter/auto");
  const durationMs = Date.now() - startMs;

  let assistantContent =
    response.choices[0]?.message?.content || "I couldn't generate a response.";

  // Parse and execute any actions in the response
  const actions = parseActions(assistantContent);
  if (actions.length > 0) {
    console.log(`[Lyra Actions] Parsed ${actions.length} actions from response:`,
      actions.map(a => `${a.type}(${a.params.issueKey || a.params.projectKey || '?'})`));

    // Deduplicate: keep only the last action per (type, issueKey) pair
    const seen = new Map<string, number>();
    actions.forEach((action, i) => {
      const key = `${action.type}:${action.params.issueKey || ''}`;
      seen.set(key, i);
    });
    const deduped = actions.filter((_, i) => [...seen.values()].includes(i));

    if (deduped.length < actions.length) {
      console.log(`[Lyra Actions] Deduped to ${deduped.length} actions`);
    }

    const actionResults: string[] = [];
    for (const action of deduped) {
      const result = await executeAction(action);
      console.log(`[Lyra Actions] ${action.type} → ${result.slice(0, 100)}`);
      actionResults.push(result);
    }

    // Strip action blocks AND any LLM-fabricated result lines from the visible response
    assistantContent = assistantContent
      .replace(/\[ACTION:[^\]]+\]/g, "")
      .replace(/^.*:(white_check_mark|warning|x): .*(Created|Transitioned|Updated|Deleted|Added comment|Got issue).*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Append ONLY the real results from executeAction
    assistantContent += "\n\n---\n" + actionResults.join("\n");
  }

  // Save assistant response
  await prisma.chatMessage.create({
    data: { projectId: null, role: "assistant", content: assistantContent },
  });

  // Log usage
  await prisma.aiUsageLog.create({
    data: {
      projectId: null,
      document: "chat-general",
      provider: "openrouter",
      requestedModel: "openrouter/auto",
      actualModel: response.model || "openrouter/auto",
      promptTokens: response.usage?.prompt_tokens || 0,
      completionTokens: response.usage?.completion_tokens || 0,
      totalTokens: response.usage?.total_tokens || 0,
      cost: response.usage?.cost || 0,
      durationMs,
      tokensPerSecond: durationMs > 0
        ? ((response.usage?.completion_tokens || 0) / (durationMs / 1000))
        : 0,
    },
  });

  return assistantContent;
}

// ── Summarize general chat messages ───────────────────────────────

async function summarizeGeneralMessages(): Promise<void> {
  const oldMessages = await prisma.chatMessage.findMany({
    where: {
      projectId: null,
      role: { not: "system" },
    },
    orderBy: { createdAt: "asc" },
    take: SUMMARIZE_BATCH,
  });

  if (oldMessages.length < SUMMARIZE_BATCH) return;

  const hasNonSummary = oldMessages.some((m) => {
    if (!m.metadata) return true;
    try {
      const meta = JSON.parse(m.metadata);
      return meta.type !== "summary";
    } catch {
      return true;
    }
  });
  if (!hasNonSummary) return;

  const conversationText = oldMessages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const summaryResponse = await chat(
    [
      {
        role: "system",
        content:
          "Summarize this conversation concisely. Capture key decisions, action items, Jira changes made, and important context. Keep it under 300 words.",
      },
      { role: "user", content: conversationText },
    ],
    "openrouter/auto"
  );

  const summary =
    summaryResponse.choices[0]?.message?.content || "Conversation summary.";

  await prisma.chatMessage.create({
    data: {
      projectId: null,
      role: "system",
      content: `[Conversation Summary] ${summary}`,
      metadata: JSON.stringify({
        type: "summary",
        summarizedCount: oldMessages.length,
        summarizedRange: {
          from: oldMessages[0].createdAt.toISOString(),
          to: oldMessages[oldMessages.length - 1].createdAt.toISOString(),
        },
      }),
    },
  });

  await prisma.chatMessage.deleteMany({
    where: {
      id: { in: oldMessages.map((m) => m.id) },
    },
  });
}
