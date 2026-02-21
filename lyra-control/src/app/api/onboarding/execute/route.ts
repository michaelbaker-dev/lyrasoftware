import { prisma } from "@/lib/db";
import { createSSEStream, sseResponse } from "@/lib/sse";
import {
  setupGitHubInternal,
  useExistingGitHubInternal,
  setupJiraInternal,
  scaffoldFilesInternal,
  setupLyraTeamInternal,
  runValidationInternal,
} from "@/app/onboarding/actions";
import type { StepResult } from "@/app/onboarding/actions";
import { createBreakdownInJira, type WorkBreakdown } from "@/lib/work-breakdown";
import { setupProjectChannel } from "@/lib/messaging/slack";

export async function POST(request: Request) {
  const { jiraKey } = (await request.json()) as { jiraKey: string };

  if (!jiraKey) {
    return Response.json({ error: "jiraKey is required" }, { status: 400 });
  }

  const project = await prisma.project.findUnique({ where: { jiraKey } });
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const { stream, send, close } = createSSEStream();

  const stepDefs: { name: string; run: () => Promise<StepResult> }[] = [
    {
      name: "GitHub",
      run: () => {
        const hasExisting = Boolean(project.existingRepo?.trim());
        if (hasExisting) {
          return useExistingGitHubInternal({ jiraKey, repoUrl: project.existingRepo! });
        }
        return setupGitHubInternal({
          projectName: project.name,
          description: project.description || project.vision?.split("\n")[0].slice(0, 200) || "",
        });
      },
    },
    {
      name: "Jira",
      run: () =>
        setupJiraInternal({
          projectName: project.name,
          jiraKey,
          description: project.description || "",
        }),
    },
    {
      name: "Work Breakdown",
      run: async (): Promise<StepResult> => {
        if (project.breakdownStatus !== "approved" || !project.breakdownContent) {
          return { success: true, logs: ["No approved breakdown — skipping Jira issue creation"] };
        }
        try {
          const breakdown = JSON.parse(project.breakdownContent) as WorkBreakdown;
          const { created, logs } = await createBreakdownInJira(jiraKey, breakdown);
          return { success: true, logs: [`Created ${created} issues in Jira`, ...logs] };
        } catch (e) {
          return { success: false, logs: [], error: (e as Error).message };
        }
      },
    },
    {
      name: "Scaffold",
      run: () =>
        scaffoldFilesInternal({
          projectName: project.name,
          localPath: project.path,
          jiraKey,
        }),
    },
    {
      name: "Team Setup",
      run: () =>
        setupLyraTeamInternal({
          projectName: project.name,
          jiraKey,
        }),
    },
    {
      name: "Slack Channel",
      run: async (): Promise<StepResult> => {
        // Only attempt if Slack is enabled
        const slackEnabled = await prisma.setting.findUnique({
          where: { key: "slack_enabled" },
        });
        if (slackEnabled?.value !== "true") {
          return { success: true, logs: ["Slack not enabled — skipping channel creation"] };
        }
        try {
          const channelId = await setupProjectChannel(project.id);
          return {
            success: true,
            logs: [`Created Slack channel #lyra-${jiraKey.toLowerCase()} (${channelId})`],
          };
        } catch (e) {
          // Non-fatal — don't block onboarding if Slack fails
          return {
            success: true,
            logs: [`Slack channel creation failed (non-fatal): ${(e as Error).message}`],
          };
        }
      },
    },
    {
      name: "Validation",
      run: () =>
        runValidationInternal({
          projectName: project.name,
          jiraKey,
          localPath: project.path,
        }),
    },
  ];

  // Run steps sequentially in the background, streaming events as they complete
  (async () => {
    try {
      for (let i = 0; i < stepDefs.length; i++) {
        const step = stepDefs[i];
        send("step-start", { name: step.name, index: i });

        const result = await step.run();
        send("step-complete", {
          name: step.name,
          index: i,
          status: result.success ? "success" : "failed",
          logs: result.logs,
          error: result.error,
        });

        if (!result.success) {
          send("done", { success: false, error: `${step.name} failed: ${result.error}` });
          close();
          return;
        }
      }

      send("done", { success: true });
    } catch (e) {
      send("done", { success: false, error: (e as Error).message });
    } finally {
      close();
    }
  })();

  return sseResponse(stream);
}
