import { prisma } from "@/lib/db";

function relativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

interface IconMapping {
  symbol: string;
  type: string;
}

function mapActionToIcon(action: string): IconMapping {
  if (action === "agent.started") return { symbol: ">", type: "start" };
  if (action === "agent.completed") return { symbol: "\u2713", type: "success" };
  if (action === "agent.failed") return { symbol: "!", type: "warning" };
  if (action === "dispatcher.poll_error") return { symbol: "\u00d7", type: "error" };
  return { symbol: "i", type: "info" };
}

const typeColors: Record<string, string> = {
  start: "text-blue-400",
  success: "text-green-400",
  warning: "text-yellow-400",
  info: "text-gray-400",
  error: "text-red-400",
};

export default async function ActivityFeed() {
  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: 10,
  });

  return (
    <div className="bg-gray-800 rounded-lg border border-gray-700 p-6">
      <h2 className="text-xl font-semibold text-gray-100 mb-4">Recent Activity</h2>

      <div className="space-y-4">
        {logs.length === 0 && (
          <p className="text-sm text-gray-500">No activity yet</p>
        )}
        {logs.map((log) => {
          const { symbol, type } = mapActionToIcon(log.action);
          let description = `${log.actor}: ${log.action}`;
          try {
            const details = JSON.parse(log.details);
            if (details.ticketKey) {
              description = `${log.actor} ${log.action.replace(".", " ")} ${details.ticketKey}`;
            }
            if (details.error) {
              description = `${log.action.replace(".", " ")}: ${details.error.slice(0, 80)}`;
            }
          } catch {
            // details not JSON, use default description
          }

          return (
            <div key={log.id} className="flex items-start space-x-3">
              <div className="flex-shrink-0 w-8 h-8 bg-gray-900 rounded-full flex items-center justify-center text-lg font-bold">
                <span className={typeColors[type] ?? typeColors.info}>{symbol}</span>
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-sm ${typeColors[type] ?? typeColors.info}`}>
                  {description}
                </p>
                <p className="text-xs text-gray-500 mt-1">{relativeTime(log.createdAt)}</p>
              </div>
            </div>
          );
        })}
      </div>

      <div className="mt-4 pt-4 border-t border-gray-700">
        <button className="text-sm text-blue-400 hover:text-blue-300 transition-colors">
          View all activity →
        </button>
      </div>
    </div>
  );
}
