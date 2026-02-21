/**
 * Database client — Prisma for SQLite relational data.
 * Singleton pattern to prevent multiple instances in development.
 *
 * Invalidates cached client when schema changes add new models
 * (detects missing properties on the cached PrismaClient).
 */

import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// Invalidate stale client if it lacks newly-generated models
if (globalForPrisma.prisma && !("triageLog" in globalForPrisma.prisma)) {
  globalForPrisma.prisma = undefined;
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
