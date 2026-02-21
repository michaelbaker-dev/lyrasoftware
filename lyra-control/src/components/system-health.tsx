import { prisma } from "@/lib/db";
import { getState } from "@/lib/dispatcher";

export default async function SystemHealth() {
  const dispatcherState = getState();

  const [activeProjectCount, runningAgentCount] = await Promise.all([
    prisma.project.count({ where: { status: "active" } }),
    prisma.agent.count({ where: { status: "running" } }),
  ]);

  const services = [
    {
      name: "Dispatcher",
      status: dispatcherState.running ? "running" : "stopped",
      color: dispatcherState.running ? "bg-green-500" : "bg-red-500",
    },
    {
      name: "Active Projects",
      status: String(activeProjectCount),
      color: activeProjectCount > 0 ? "bg-green-500" : "bg-gray-500",
    },
    {
      name: "Running Agents",
      status: String(runningAgentCount),
      color:
        runningAgentCount > 0
          ? "bg-green-500"
          : "bg-gray-500",
    },
  ];

  return (
    <div className="flex items-center space-x-4 bg-gray-900 rounded-lg border border-gray-700 px-4 py-2">
      {services.map((service) => (
        <div key={service.name} className="flex items-center space-x-2">
          <div className={`w-2 h-2 rounded-full ${service.color}`} />
          <span className="text-xs text-gray-300">
            {service.name}
            <span className="text-gray-500 ml-1">({service.status})</span>
          </span>
        </div>
      ))}
    </div>
  );
}
