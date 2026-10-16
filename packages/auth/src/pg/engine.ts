import type { betterAuth, BetterAuthOptions } from 'better-auth';

/**
 * The engine instance. Typed with the general options, so plugin-specific endpoints are reached
 * through `handler`; the core API (`getSession`, `$context`) stays typed.
 */
export type AuthEngine = ReturnType<typeof betterAuth<BetterAuthOptions>>;
