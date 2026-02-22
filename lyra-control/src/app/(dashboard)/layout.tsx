import { redirect } from "next/navigation";
import { Sidebar } from "@/components/sidebar";
import { ensureLyraRunning } from "@/lib/init";
import { getSession, ensureDefaultAdmin } from "@/lib/auth";

ensureLyraRunning();
ensureDefaultAdmin();

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session.isLoggedIn) {
    redirect("/login");
  }

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 overflow-auto p-6">{children}</main>
    </div>
  );
}
