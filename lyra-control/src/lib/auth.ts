import { cookies } from "next/headers";
import { getIronSession } from "iron-session";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { SessionData, defaultSession, sessionOptions } from "./session";

const prisma = new PrismaClient();
const SALT_ROUNDS = 12;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes

export async function getSession() {
  const cookieStore = await cookies();
  const session = await getIronSession<SessionData>(cookieStore, sessionOptions);
  return session;
}

export async function createSession(user: {
  id: string;
  email: string;
  role: string;
}) {
  const session = await getSession();
  session.userId = user.id;
  session.email = user.email;
  session.role = user.role;
  session.isLoggedIn = true;
  await session.save();
}

export async function destroySession() {
  const session = await getSession();
  session.destroy();
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export async function authenticateUser(
  email: string,
  password: string
): Promise<
  | { success: true; user: { id: string; email: string; role: string } }
  | { success: false; error: string }
> {
  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    return { success: false, error: "Invalid email or password" };
  }

  // Check lockout
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const minutesLeft = Math.ceil(
      (user.lockedUntil.getTime() - Date.now()) / 60000
    );
    return {
      success: false,
      error: `Account locked. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? "s" : ""}.`,
    };
  }

  const valid = await verifyPassword(password, user.passwordHash);

  if (!valid) {
    const attempts = user.failedAttempts + 1;
    const update: { failedAttempts: number; lockedUntil?: Date } = {
      failedAttempts: attempts,
    };

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      update.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
    }

    await prisma.user.update({ where: { id: user.id }, data: update });

    if (attempts >= MAX_FAILED_ATTEMPTS) {
      return { success: false, error: "Account locked for 15 minutes due to too many failed attempts." };
    }

    return { success: false, error: "Invalid email or password" };
  }

  // Success — reset failed attempts and update last login
  await prisma.user.update({
    where: { id: user.id },
    data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  return {
    success: true,
    user: { id: user.id, email: user.email, role: user.role },
  };
}

export async function ensureDefaultAdmin(): Promise<void> {
  const count = await prisma.user.count();
  if (count > 0) return;

  const passwordHash = await hashPassword("password");
  await prisma.user.create({
    data: {
      email: "mbakers@mac.com",
      passwordHash,
      name: "Mike",
      role: "admin",
    },
  });
}
