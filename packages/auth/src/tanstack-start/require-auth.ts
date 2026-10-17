import type { AnyRedirect } from '@tanstack/react-router';
import { redirect } from '@tanstack/react-router';

type SessionPrefetchFn = () => Promise<unknown>;

/**
 * Builds the redirect thrown when there is no session. The app calls TanStack Router's own
 * `redirect()`, so the target is checked against the app's routes:
 * `() => redirect({ to: '/auth/$', params: { _splat: 'sign-in' } })`.
 */
export type SignInRedirect = () => AnyRedirect;

/** @deprecated Pass a {@link SignInRedirect} instead; this object form goes away in the delete step. */
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
 *
 * @example
 * export const requireAuth = createRequireAuth(prefetchSessionFn, () =>
 *   redirect({ to: '/auth/$', params: { _splat: 'sign-in' } }),
 * );
 */
export function createRequireAuth(
  prefetchSessionFn: SessionPrefetchFn,
  signIn: SignInRedirect | RequireAuthOptions = {},
) {
  const toSignIn = typeof signIn === 'function' ? signIn : legacySignInRedirect(signIn);
  return async function requireAuth() {
    const session = await prefetchSessionFn();
    if (!session) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is thrown by design
      throw toSignIn();
    }
  };
}

function legacySignInRedirect({
  signInTo = '/auth/$',
  signInParams = { _splat: 'sign-in' },
  signInSearch,
}: RequireAuthOptions): SignInRedirect {
  return () => {
    const opts = {
      to: signInTo,
      params: signInParams,
      ...(signInSearch && { search: signInSearch }),
    };
    return redirect(opts as unknown as Parameters<typeof redirect>[0]);
  };
}
