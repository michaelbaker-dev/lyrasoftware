"use server";

import { redirect } from "next/navigation";
import {
  authenticateUser,
  createSession,
  destroySession,
} from "@/lib/auth";

export type AuthFormState = {
  error?: string;
};

export async function loginAction(
  _prevState: AuthFormState,
  formData: FormData
): Promise<AuthFormState> {
  const email = formData.get("email") as string;
  const password = formData.get("password") as string;

  if (!email || !password) {
    return { error: "Email and password are required" };
  }

  const result = await authenticateUser(email, password);

  if (!result.success) {
    return { error: result.error };
  }

  await createSession(result.user);
  const from = formData.get("from") as string;
  redirect(from || "/");
}

export async function logoutAction() {
  await destroySession();
  redirect("/login");
}
