import { prisma } from "@/lib/db";
import { planSprint, startSprint, completeSprint, updateSprintProgress, analyzeTeamGaps } from "@/lib/sprint-planner";
import { gatherDemoData } from "@/lib/sprint-demo-data";
import { generateLaunchScript, generateAndValidateLaunchScript } from "@/lib/launch-generator";
import { launchApp, stopApp, getAppStatus } from "@/lib/process-manager";
import { generateReleaseNotes } from "@/lib/release-notes-generator";
import { lyraEvents } from "@/lib/lyra-events";
import { analyzeCodebase, type CodebaseAnalysis, type AnalysisMode } from "@/lib/codebase-analyzer";
import { createBreakdownInJira, type WorkBreakdown } from "@/lib/work-breakdown";
import { moveIssuesToSprint } from "@/lib/jira";
import { NextRequest } from "next/server";

// In-memory cache for launch analysis (avoids DB column, TTL = 10 min)
const launchAnalysisCache = new Map<string, { analysis: CodebaseAnalysis; expiresAt: number }>();
const LAUNCH_CACHE_TTL = 10 * 60 * 1000;

/** Ensure codebase analysis exists for a project, running it on-demand if needed.
 *  Use mode="launch" for faster analysis that skips expensive deep inspection. */
async function ensureAnalysis(
  project: { id: string; path: string; codebaseAnalysis: string | null },
  mode: AnalysisMode = "full"
): Promise<CodebaseAnalysis> {
  // For full mode, use the cached analysis if available
  if (project.codebaseAnalysis && mode === "full") {
    return JSON.parse(project.codebaseAnalysis) as CodebaseAnalysis;
  }

  // For launch mode, check in-memory cache first
  if (mode === "launch") {
    const cached = launchAnalysisCache.get(project.id);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.analysis;
    }

    // Reuse full analysis from DB if available (it's a superset)
    if (project.codebaseAnalysis) {
      const fullAnalysis = JSON.parse(project.codebaseAnalysis) as CodebaseAnalysis;
      launchAnalysisCache.set(project.id, {
        analysis: fullAnalysis,
        expiresAt: Date.now() + LAUNCH_CACHE_TTL,
      });
      return fullAnalysis;
    }
  }

  const analysis = await analyzeCodebase(project.path, mode);

  if (mode === "full") {
    await prisma.project.update({
      where: { id: project.id },
      data: { codebaseAnalysis: JSON.stringify(analysis), analysisStatus: "complete" },
    });
  } else {
    // Cache launch analysis in memory
    launchAnalysisCache.set(project.id, {
      analysis,
      expiresAt: Date.now() + LAUNCH_CACHE_TTL,
    });
  }

  return analysis;
}

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get("projectId");
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  const sprints = await prisma.sprint.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });

  return Response.json({ sprints });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { action } = body;

  try {
    switch (action) {
      case "plan": {
        const { projectId, sprintName, goal, model } = body;
        if (!projectId || !sprintName) {
          return Response.json({ error: "projectId and sprintName are required" }, { status: 400 });
        }
        const result = await planSprint({ projectId, sprintName, goal, model });
        const gaps = await analyzeTeamGaps(projectId, result.sprint.selectedKeys);
        return Response.json({ success: true, ...result, gaps });
      }

      case "start": {
        const { sprintId } = body;
        if (!sprintId) {
          return Response.json({ error: "sprintId is required" }, { status: 400 });
        }
        const result = await startSprint(sprintId);
        return Response.json({ success: true, ...result });
      }

      case "complete": {
        const { sprintId } = body;
        if (!sprintId) {
          return Response.json({ error: "sprintId is required" }, { status: 400 });
        }
        const result = await completeSprint(sprintId);
        return Response.json({ success: true, ...result });
      }

      case "demo": {
        const { projectId, sprintId } = body;
        if (!projectId || !sprintId) {
          return Response.json({ error: "projectId and sprintId are required" }, { status: 400 });
        }
        const demoData = await gatherDemoData(projectId, sprintId);
        const appStatus = getAppStatus(projectId);
        return Response.json({ ...demoData, appStatus });
      }

      case "generate-launch": {
        const { projectId, maxRetries = 3, model } = body;
        if (!projectId) {
          return Response.json({ error: "projectId is required" }, { status: 400 });
        }
        const project = await prisma.project.findUnique({ where: { id: projectId } });
        if (!project) {
          return Response.json({ error: "Project not found" }, { status: 404 });
        }

        lyraEvents.emit("launch:progress", { projectId, step: "analyzing" });
        const analysis = await ensureAnalysis(project, "launch");

        const result = await generateAndValidateLaunchScript(
          projectId,
          project.path,
          analysis,
          Math.min(Math.max(Number(maxRetries) || 3, 1), 10),
          model || undefined
        );

        return Response.json({
          success: true,
          scriptPath: result.scriptPath,
          config: result.config,
          attempts: result.attempts,
          validated: result.validated,
          lastError: result.lastError,
          triaged: result.triaged,
          triageResult: result.triageResult,
        });
      }

      case "launch": {
        const { projectId } = body;
        if (!projectId) {
          return Response.json({ error: "projectId is required" }, { status: 400 });
        }
        const project = await prisma.project.findUnique({ where: { id: projectId } });
        if (!project) {
          return Response.json({ error: "Project not found" }, { status: 404 });
        }

        const { existsSync, readFileSync: rfs } = await import("fs");
        const { join } = await import("path");
        let scriptPath = join(project.path, "lyra-launch.sh");
        let ports: number[] = [];

        if (!existsSync(scriptPath)) {
          const analysis = await ensureAnalysis(project, "launch");
          const result = await generateLaunchScript(projectId, project.path, analysis);
          scriptPath = result.scriptPath;
          ports = result.config.processes.filter(p => p.port).map(p => p.port!);
        } else {
          // Parse ports from existing script (look for localhost:PORT patterns)
          try {
            const scriptContent = rfs(scriptPath, "utf-8");
            const portMatches = scriptContent.matchAll(/localhost:(\d+)/g);
            ports = [...portMatches].map(m => parseInt(m[1], 10));
          } catch {
            // No ports detected
          }
        }

        launchApp(projectId, scriptPath, project.path, ports);
        return Response.json({ success: true, ports });
      }

      case "stop": {
        const { projectId } = body;
        if (!projectId) {
          return Response.json({ error: "projectId is required" }, { status: 400 });
        }
        const stopped = stopApp(projectId);
        return Response.json({ success: stopped });
      }

      case "release-notes": {
        const { projectId, sprintId } = body;
        if (!projectId || !sprintId) {
          return Response.json({ error: "projectId and sprintId are required" }, { status: 400 });
        }
        const sprint = await prisma.sprint.findUnique({ where: { id: sprintId } });
        if (!sprint) {
          return Response.json({ error: "Sprint not found" }, { status: 404 });
        }
        const demoData = await gatherDemoData(projectId, sprintId);
        const { markdown, filePath } = await generateReleaseNotes({
          projectId,
          sprintId,
          sprintName: sprint.name,
          sprintGoal: sprint.goal,
          tickets: demoData.tickets,
          totals: demoData.totals,
          projectPath: demoData.project.path,
          projectName: demoData.project.name,
          runCmd: demoData.project.runCmd,
        });
        return Response.json({ success: true, markdown, filePath });
      }

      case "merge-all": {
        const { projectId } = body;
        if (!projectId) {
          return Response.json({ error: "projectId is required" }, { status: 400 });
        }

        const { runMergeQueue } = await import("@/lib/merge-queue");
        const mergeResult = await runMergeQueue(projectId);
        return Response.json({ success: true, ...mergeResult });
      }

      case "resolve-conflicts": {
        const { projectId, conflictPRs, ticketKeys } = body;
        if (!projectId || (!Array.isArray(conflictPRs) && !Array.isArray(ticketKeys))) {
          return Response.json(
            { error: "projectId and conflictPRs[] or ticketKeys[] are required" },
            { status: 400 }
          );
        }

        const project = await prisma.project.findUnique({
          where: { id: projectId },
          select: { id: true, githubRepo: true },
        });
        if (!project || !project.githubRepo) {
          return Response.json({ error: "Project or repo not found" }, { status: 404 });
        }

        const { closePR } = await import("@/lib/github");
        const { retryTicket } = await import("@/lib/dispatcher");

        const results: Array<{
          pr: number | null;
          ticketKey: string | null;
          step: string;
          success: boolean;
          error?: string;
          sessionId?: string;
        }> = [];

        // Mode 1: Direct ticket re-dispatch (recovery — PRs already closed)
        if (Array.isArray(ticketKeys) && ticketKeys.length > 0) {
          for (const ticketKey of ticketKeys as string[]) {
            try {
              const { sessionId } = await retryTicket(ticketKey, projectId);
              results.push({
                pr: null,
                ticketKey,
                step: "redispatched",
                success: true,
                sessionId,
              });
            } catch (e) {
              results.push({
                pr: null,
                ticketKey,
                step: "redispatch",
                success: false,
                error: (e as Error).message,
              });
            }
          }
        }

        // Mode 2: Close PRs then re-dispatch (from merge conflict results)
        if (Array.isArray(conflictPRs)) {
          // Process sequentially so agents don't trample each other
          for (const item of conflictPRs as Array<{ pr: number; ticketKey: string | null }>) {
            // Step 1: Close the PR and delete the branch
            const closeResult = await closePR(project.githubRepo, item.pr, true, projectId);
            if (!closeResult.closed) {
              results.push({
                pr: item.pr,
                ticketKey: item.ticketKey,
                step: "close",
                success: false,
                error: closeResult.error,
              });
              continue;
            }

            // Step 2: Re-dispatch if we have a ticket key
            if (item.ticketKey) {
              try {
                const { sessionId } = await retryTicket(item.ticketKey, projectId);
                results.push({
                  pr: item.pr,
                  ticketKey: item.ticketKey,
                  step: "redispatched",
                  success: true,
                  sessionId,
                });
              } catch (e) {
                results.push({
                  pr: item.pr,
                  ticketKey: item.ticketKey,
                  step: "redispatch",
                  success: false,
                  error: (e as Error).message,
                });
              }
            } else {
              results.push({
                pr: item.pr,
                ticketKey: null,
                step: "closed-only",
                success: true,
              });
            }
          }
        }

        // Audit log for re-dispatch operations
        await prisma.auditLog.create({
          data: {
            projectId,
            actor: "lyra",
            action: "resolve_conflicts.run",
            details: JSON.stringify({
              total: results.length,
              succeeded: results.filter(r => r.success).length,
              failed: results.filter(r => !r.success).length,
            }),
          },
        });

        return Response.json({ success: true, results });
      }

      case "populate-backlog": {
        const { projectId } = body;
        if (!projectId) {
          return Response.json({ error: "projectId is required" }, { status: 400 });
        }
        const project = await prisma.project.findUnique({ where: { id: projectId } });
        if (!project) {
          return Response.json({ error: "Project not found" }, { status: 404 });
        }
        if (project.breakdownStatus !== "approved") {
          return Response.json(
            { error: "No approved work breakdown found. Generate and approve a breakdown in onboarding first." },
            { status: 400 }
          );
        }
        if (!project.breakdownContent) {
          return Response.json(
            { error: "Breakdown content is missing despite approved status." },
            { status: 400 }
          );
        }

        const breakdown = JSON.parse(project.breakdownContent) as WorkBreakdown;
        const result = await createBreakdownInJira(project.jiraKey, breakdown);

        // Move newly created stories into the active sprint so the dispatcher picks them up
        if (project.activeSprintId && result.createdKeys.length > 0) {
          await moveIssuesToSprint(project.activeSprintId, result.createdKeys);
          result.logs.push(`Moved ${result.createdKeys.length} stories to active sprint ${project.activeSprintId}`);
        }

        await prisma.auditLog.create({
          data: {
            projectId,
            actor: "user",
            action: "breakdown.populated_jira",
            details: JSON.stringify({ created: result.created, movedToSprint: !!project.activeSprintId }),
          },
        });

        await prisma.project.update({
          where: { id: projectId },
          data: { breakdownStatus: "populated" },
        });

        return Response.json({ success: true, created: result.created, logs: result.logs });
      }

      case "create-agent": {
        const { projectId, role } = body;
        if (!projectId || !role) {
          return Response.json({ error: "projectId and role are required" }, { status: 400 });
        }
        const { createAgentForRole } = await import("@/app/(dashboard)/projects/[id]/team-actions");
        const agentResult = await createAgentForRole(projectId, role);
        if (!agentResult.success) {
          return Response.json({ error: agentResult.error }, { status: 400 });
        }
        return Response.json({ success: true, agentName: agentResult.agentName });
      }

      case "force-resolve": {
        const { projectId, ticketKey } = body;
        if (!projectId || !ticketKey) {
          return Response.json({ error: "projectId and ticketKey are required" }, { status: 400 });
        }

        const { killAgent, transitionToStatus } = await import("@/lib/dispatcher");

        // Kill running agent if any
        killAgent(ticketKey);

        // Update any running sessions for this ticket
        await prisma.session.updateMany({
          where: { ticketKey, projectId, status: "running" },
          data: { status: "failed", completedAt: new Date() },
        });

        // Set agents back to idle
        await prisma.agent.updateMany({
          where: { projectId, currentTicket: ticketKey, status: "running" },
          data: { status: "idle", currentTicket: null, startedAt: null },
        });

        // Transition to Done in Jira
        await transitionToStatus(ticketKey, "Done");

        await prisma.auditLog.create({
          data: {
            projectId,
            actor: "user",
            action: "ticket.force_resolved",
            details: JSON.stringify({ ticketKey }),
          },
        });

        return Response.json({ success: true });
      }

      case "kill-agent": {
        const { projectId, ticketKey } = body;
        if (!projectId || !ticketKey) {
          return Response.json({ error: "projectId and ticketKey are required" }, { status: 400 });
        }

        const { killAgent: killAgentFn, transitionToStatus: transitionFn } = await import("@/lib/dispatcher");

        const killed = killAgentFn(ticketKey);
        if (!killed) {
          return Response.json({ error: "No running agent found for this ticket" }, { status: 404 });
        }

        // Update session to failed
        await prisma.session.updateMany({
          where: { ticketKey, projectId, status: "running" },
          data: { status: "failed", completedAt: new Date() },
        });

        // Set agent back to idle
        await prisma.agent.updateMany({
          where: { projectId, currentTicket: ticketKey, status: "running" },
          data: { status: "idle", currentTicket: null, startedAt: null },
        });

        // Transition back to To Do so dispatcher can retry
        await transitionFn(ticketKey, "To Do");

        await prisma.auditLog.create({
          data: {
            projectId,
            actor: "user",
            action: "agent.killed",
            details: JSON.stringify({ ticketKey }),
          },
        });

        return Response.json({ success: true });
      }

      case "retry-ticket": {
        const { projectId, ticketKey } = body;
        if (!projectId || !ticketKey) {
          return Response.json({ error: "projectId and ticketKey are required" }, { status: 400 });
        }

        const { retryTicket: retryFn } = await import("@/lib/dispatcher");
        const { sessionId } = await retryFn(ticketKey, projectId);
        return Response.json({ success: true, sessionId });
      }

      case "refresh": {
        const { projectId } = body;
        if (!projectId) {
          return Response.json({ error: "projectId is required" }, { status: 400 });
        }
        await updateSprintProgress(projectId);
        return Response.json({ success: true });
      }

      default:
        return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
