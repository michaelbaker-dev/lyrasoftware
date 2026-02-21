import { prisma } from "@/lib/db";

function formatElapsed(startedAt: Date | null): string {
  if (!startedAt) return "-";
  const diffMs = Date.now() - startedAt.getTime();
  const totalSeconds = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

const statusOrder: Record<string, number> = {
  running: 0,
  "rate-limited": 1,
  errored: 2,
  idle: 3,
};

export default async function AgentStatusPanel() {
  const agents = await prisma.agent.findMany({
    include: { project: true },
    orderBy: { updatedAt: "desc" },
  });

  // Sort by status priority (running first)
  agents.sort(
    (a, b) => (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99)
  );

  const statusStyles: Record<string, string> = {
    idle: "bg-gray-600 text-gray-100",
    running: "bg-green-600 text-white",
    errored: "bg-red-600 text-white",
    "rate-limited": "bg-yellow-600 text-gray-900",
  };

  const roleColors: Record<string, string> = {
    dev: "text-blue-400",
    qa: "text-green-400",
    architect: "text-purple-400",
  };

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
      <h2 className="text-xl font-semibold text-gray-100 mb-4">Active Agents</h2>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Agent</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Role</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Project</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Current Ticket</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Status</th>
              <th className="text-left py-3 px-4 text-sm font-medium text-gray-400">Elapsed</th>
            </tr>
          </thead>
          <tbody>
            {agents.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-sm text-gray-500">
                  No agents registered
                </td>
              </tr>
            )}
            {agents.map((agent) => (
              <tr key={agent.id} className="border-b border-gray-700/50 hover:bg-gray-750">
                <td className="py-3 px-4 text-sm text-gray-100 font-mono">{agent.name}</td>
                <td className="py-3 px-4">
                  <span className={`text-sm font-medium ${roleColors[agent.role] ?? "text-gray-400"}`}>
                    {agent.role}
                  </span>
                </td>
                <td className="py-3 px-4 text-sm text-gray-300">
                  {agent.project?.jiraKey ?? "-"}
                </td>
                <td className="py-3 px-4 text-sm text-gray-300 font-mono">
                  {agent.currentTicket ?? "-"}
                </td>
                <td className="py-3 px-4">
                  <span
                    className={`inline-block px-2 py-1 text-xs rounded-full font-medium ${statusStyles[agent.status] ?? statusStyles.idle}`}
                  >
                    {agent.status}
                  </span>
                </td>
                <td className="py-3 px-4 text-sm text-gray-400 font-mono">
                  {agent.status === "running" ? formatElapsed(agent.startedAt) : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
