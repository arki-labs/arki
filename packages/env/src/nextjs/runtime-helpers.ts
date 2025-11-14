/**
 * Type-safe helper to map server environment variables
 * Explicitly destructures each variable for Next.js bundler compatibility
 */
export function serverEnv<T extends readonly string[]>(keys: T): Record<T[number], string | undefined> {
  const env: Record<string, string | undefined> = {};

  // Explicit destructuring required for Next.js static analysis
  for (const key of keys) {
    env[key] = process.env[key];
  }

  return env as Record<T[number], string | undefined>;
}

/**
 * Type-safe helper to map client environment variables
 * Automatically handles NEXT_PUBLIC_ prefix
 */
export function clientEnv<T extends readonly string[]>(keys: T): Record<T[number], string | undefined> {
  const env: Record<string, string | undefined> = {};

  // Client vars must use NEXT_PUBLIC_ prefix
  for (const key of keys) {
    env[key] = process.env[`NEXT_PUBLIC_${key}`];
  }

  return env as Record<T[number], string | undefined>;
}
