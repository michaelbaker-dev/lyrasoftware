"use server";

import { prisma } from "@/lib/db";
import * as jira from "@/lib/jira";

export type DeleteStepResult = {
  name: string;
  status: "success" | "failed" | "skipped";
  logs: string[];
};

export type DeleteResult = {
  success: boolean;
  steps: DeleteStepResult[];
  error?: string;
};

export async function deleteProject(projectId: string): Promise<DeleteResult> {
  const steps: DeleteStepResult[] = [];

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
    });

    if (!project) {
      return { success: false, steps, error: "Project not found" };
    }

    // 1. GitHub — never delete the repo (must be done manually to prevent data loss)
    {
      const logs: string[] = [];
      if (project.githubRepo) {
        logs.push(`GitHub repo preserved: ${project.githubRepo}`);
        logs.push("Repo must be deleted manually if no longer needed");
      } else {
        logs.push("No GitHub repo associated with this project");
      }
      steps.push({ name: "GitHub", status: "skipped", logs });
    }

    // 2. Jira — delete all issues then soft-delete project
    {
      const logs: string[] = [];
      try {
        logs.push(`Searching for issues in ${project.jiraKey}...`);
        const { deleted, failed } = await jira.deleteAllProjectIssues(project.jiraKey);
        logs.push(`Deleted ${deleted} issues (${failed} failed)`);

        logs.push(`Trashing Jira project ${project.jiraKey}...`);
        try {
          await jira.deleteProject(project.jiraKey);
          logs.push("Jira project moved to trash");
        } catch (e) {
          logs.push(`Could not trash project (may require admin): ${(e as Error).message}`);
        }

        steps.push({ name: "Jira", status: failed > 0 ? "failed" : "success", logs });
      } catch (e) {
        logs.push(`Jira cleanup failed: ${(e as Error).message}`);
        steps.push({ name: "Jira", status: "failed", logs });
      }
    }

    // 3. Database — delete in FK-safe order
    {
      const logs: string[] = [];
      try {
        // Delete in FK-safe order: children before parents

        // Tables referencing Session
        const gateRuns = await prisma.qualityGateRun.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${gateRuns.count} quality gate runs`);

        const triageLogs = await prisma.triageLog.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${triageLogs.count} triage logs`);

        // Tables referencing Project (no session FK)
        const notifications = await prisma.notification.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${notifications.count} notifications`);

        const chatMessages = await prisma.chatMessage.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${chatMessages.count} chat messages`);

        const slackThreads = await prisma.slackThread.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${slackThreads.count} Slack threads`);

        const memories = await prisma.lyraMemory.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${memories.count} Lyra memories`);

        // Now safe to delete sessions, agents, etc.
        const sessions = await prisma.session.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${sessions.count} sessions`);

        const agents = await prisma.agent.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${agents.count} agents`);

        const teams = await prisma.team.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${teams.count} teams`);

        const sprints = await prisma.sprint.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${sprints.count} sprints`);

        const auditLogs = await prisma.auditLog.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${auditLogs.count} audit logs`);

        const aiUsageLogs = await prisma.aiUsageLog.deleteMany({ where: { projectId } });
        logs.push(`Deleted ${aiUsageLogs.count} AI usage logs`);

        await prisma.project.delete({ where: { id: projectId } });
        logs.push("Project record deleted");

        steps.push({ name: "Database", status: "success", logs });
      } catch (e) {
        logs.push(`Database cleanup failed: ${(e as Error).message}`);
        steps.push({ name: "Database", status: "failed", logs });
        return { success: false, steps, error: `Database cleanup failed: ${(e as Error).message}` };
      }
    }

    // 4. Source code — explicitly left on disk
    {
      const logs: string[] = [];
      logs.push(`Source code left on disk at: ${project.path}`);
      logs.push("You can manually delete the directory if no longer needed");
      steps.push({ name: "Source Code", status: "skipped", logs });
    }

    return { success: true, steps };
  } catch (e) {
    return { success: false, steps, error: (e as Error).message };
  }
}
