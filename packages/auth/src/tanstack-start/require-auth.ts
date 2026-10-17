import type { AnyRedirect } from '@tanstack/react-router';

type SessionPrefetchFn = () => Promise<unknown>;

/**
 * Builds the redirect thrown when there is no session. The app calls TanStack Router's own
 * `redirect()`, so the target is checked against the app's routes:
 * `() => redirect({ to: '/auth/$', params: { _splat: 'sign-in' } })`.
 */
export type SignInRedirect = () => AnyRedirect;

/**
 * Builds a `beforeLoad`-compatible auth guard backed by the supplied SSR
 * session prefetch function.
 *
 * The session is resolved through a `createServerFn` server function (the one
 * the caller passes in) — this is the only way to read the incoming request's
 * cookies on the server during SSR. Using the React `authClient.getSession()`
 * here would silently always return `null` on cold loads, since it has no
 * access to the request headers.
 *
 * @example
 * export const requireAuth = createRequireAuth(prefetchSessionFn, () =>
 *   redirect({ to: '/auth/$', params: { _splat: 'sign-in' } }),
 * );
 */
export function createRequireAuth(prefetchSessionFn: SessionPrefetchFn, signIn: SignInRedirect) {
  return async function requireAuth() {
    const session = await prefetchSessionFn();
    if (!session) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is thrown by design
      throw signIn();
    }
  };
}
