"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { name: "Dashboard", href: "/", icon: "⬡" },
  { name: "Onboarding", href: "/onboarding", icon: "+" },
  { name: "Projects", href: "/projects", icon: "▦" },
  { name: "Sprints", href: "/sprints", icon: "⟳" },
  { name: "Agents", href: "/agents", icon: "◉" },
  { name: "Ceremonies", href: "/ceremonies", icon: "◎" },
  { name: "Notifications", href: "/notifications", icon: "▣" },
  { name: "Blockers", href: "/blockers", icon: "⚠" },
  { name: "Triage Log", href: "/triage", icon: "◇" },
  { name: "Metrics", href: "/metrics", icon: "▤" },
  { name: "Costs", href: "/costs", icon: "$" },
  { name: "Settings", href: "/settings", icon: "⚙" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex w-64 flex-col border-r border-gray-800 bg-gray-900">
      <div className="flex h-16 items-center gap-2 border-b border-gray-800 px-6">
        <span className="text-2xl">◈</span>
        <h1 className="text-lg font-semibold">Lyra Control</h1>
      </div>
      <nav className="flex-1 space-y-1 p-4">
        {navigation.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.name}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-blue-600/20 text-blue-400"
                  : "text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              }`}
            >
              <span className="text-lg">{item.icon}</span>
              {item.name}
            </Link>
          );
        })}
      </nav>
      <div className="border-t border-gray-800 p-4">
        <div className="text-xs text-gray-500">Lyra Control v0.1.0</div>
      </div>
    </aside>
  );
}
