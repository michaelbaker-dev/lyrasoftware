/**
 * Returns the base path prefix for client-side API calls.
 * Next.js basePath is NOT automatically prepended for fetch() or EventSource.
 */
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

/**
 * Prepend the basePath to an API URL.
 * Usage: api("/api/events") → "/lyra/api/events"
 */
export function api(path: string): string {
  return `${basePath}${path}`;
}
