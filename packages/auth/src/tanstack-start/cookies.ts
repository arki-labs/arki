import type { BetterAuthPlugin } from 'better-auth';
import { tanstackStartCookies } from 'better-auth/tanstack-start';

/**
 * Lets server functions and loaders in a TanStack Start app set the auth cookies. Pass it in the
 * auth bindings' `plugins` of a backend served by TanStack Start; a standalone server does not
 * need it.
 */
export function tanstackStart(): BetterAuthPlugin {
  return tanstackStartCookies();
}
