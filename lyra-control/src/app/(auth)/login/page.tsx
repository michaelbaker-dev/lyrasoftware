import { redirect } from "next/navigation";
import { getSession, ensureDefaultAdmin } from "@/lib/auth";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string }>;
}) {
  await ensureDefaultAdmin();

  const session = await getSession();
  if (session.isLoggedIn) {
    redirect("/");
  }

  const params = await searchParams;

  return (
    <div>
      <div className="text-center">
        <span className="text-4xl">◈</span>
        <h1 className="mt-4 text-2xl font-bold">Lyra Control</h1>
        <p className="mt-2 text-gray-400">Sign in to continue</p>
      </div>
      <LoginForm from={params.from} />
    </div>
  );
}
