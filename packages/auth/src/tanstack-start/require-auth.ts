import { redirect } from '@tanstack/react-router';

type SessionPrefetchFn = () => Promise<unknown>;

export type RequireAuthOptions = {
  /**
   * Route target for unauthenticated users. Passed through to TanStack Router's
   * `redirect()`. Default: `'/auth/$'` with `{ _splat: 'sign-in' }`.
   */
  signInTo?: string;
  signInParams?: Record<string, string>;
  signInSearch?: Record<string, unknown>;
};

/**
 * Builds a `beforeLoad`-compatible auth guard backed by the supplied SSR
 * session prefetch function.
 *
 * The session is resolved through a `createServerFn` server function (the one
 * the caller passes in) — this is the only way to read the incoming request's
 * cookies on the server during SSR. Using the React `authClient.getSession()`
 * here would silently always return `null` on cold loads, since it has no
 * access to the request headers.
 */
export function createRequireAuth(
  prefetchSessionFn: SessionPrefetchFn,
  { signInTo = '/auth/$', signInParams = { _splat: 'sign-in' }, signInSearch }: RequireAuthOptions = {},
) {
  return async function requireAuth() {
    const session = await prefetchSessionFn();
    if (!session) {
      const opts = {
        to: signInTo,
        params: signInParams,
        ...(signInSearch && { search: signInSearch }),
      };
      throw redirect(opts as unknown as Parameters<typeof redirect>[0]);
    }
  };
}
