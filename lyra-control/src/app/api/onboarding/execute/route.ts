import { prisma } from "@/lib/db";
import { createSSEStream, sseResponse } from "@/lib/sse";
import {
  setupGitHubInternal,
  useExistingGitHubInternal,
  setupJiraInternal,
  scaffoldFilesInternal,
  setupLyraTeamInternal,
  runValidationInternal,
} from "@/app/(dashboard)/onboarding/actions";
import type { StepResult } from "@/app/(dashboard)/onboarding/actions";
import { createBreakdownInJira, type WorkBreakdown } from "@/lib/work-breakdown";
import { setupProjectChannel, reinviteOwner } from "@/lib/messaging/slack";

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
        const slackSettings = await prisma.setting.findMany({
          where: { key: { in: ["slack_enabled", "slack_bot_token", "slack_owner_user_id"] } },
        });
        const settingsMap: Record<string, string> = {};
        for (const s of slackSettings) settingsMap[s.key] = s.value;

        if (settingsMap.slack_enabled !== "true") {
          return { success: true, logs: ["Slack not enabled — skipping channel creation"] };
        }
        const logs: string[] = [];
        try {
          // Auto-detect owner user ID if missing
          if (!settingsMap.slack_owner_user_id && settingsMap.slack_bot_token) {
            const authRes = await fetch("https://slack.com/api/auth.test", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${settingsMap.slack_bot_token}`,
                "Content-Type": "application/json",
              },
              signal: AbortSignal.timeout(10_000),
            });
            const authData = await authRes.json();
            if (authData.ok && authData.user_id) {
              await prisma.setting.upsert({
                where: { key: "slack_owner_user_id" },
                update: { value: authData.user_id },
                create: { key: "slack_owner_user_id", value: authData.user_id },
              });
              logs.push(`Auto-detected slack_owner_user_id: ${authData.user_id}`);
            } else {
              logs.push("WARNING: slack_owner_user_id not configured — you won't be auto-invited to the channel. Set it in Settings > Channels or run the Slack test.");
            }
          }

          const channelId = await setupProjectChannel(project.id);
          logs.push(`Created Slack channel #lyra-${jiraKey.toLowerCase()} (${channelId})`);

          // Retroactively invite owner if they weren't invited during channel creation
          const ownerSetting = await prisma.setting.findUnique({ where: { key: "slack_owner_user_id" } });
          if (ownerSetting?.value) {
            const inviteResult = await reinviteOwner(channelId);
            if (inviteResult.ok) {
              logs.push(`Invited owner to channel`);
            }
          }

          return { success: true, logs };
        } catch (e) {
          // Non-fatal — don't block onboarding if Slack fails
          logs.push(`Slack channel creation failed (non-fatal): ${(e as Error).message}`);
          return { success: true, logs };
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
