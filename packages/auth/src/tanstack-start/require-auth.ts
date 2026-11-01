import type { AnyRouter, Redirect } from '@tanstack/react-router';

type SessionPrefetchFn = () => Promise<unknown>;

/**
 * Builds the redirect thrown when there is no session. The app calls TanStack Router's own
 * `redirect()`, so the target and its `search` are checked against the app's routes:
 * `() => redirect({ to: '/sign-in', search: { redirect: location.href } })`.
 *
 * The type parameters are the redirect's own, inferred from the callback. A fixed `AnyRedirect`
 * refused a typed `search` under `exactOptionalPropertyTypes` whenever the app's router types
 * came from another install than this package's (a linked checkout, another patch release).
 */
export type SignInRedirect<
  TRouter extends AnyRouter,
  TFrom extends string,
  TTo extends string | undefined,
  TMaskFrom extends string,
  TMaskTo extends string,
> = () => Redirect<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>;

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
 * beforeLoad: ({ location }) =>
 *   createRequireAuth(prefetchSessionFn, () => redirect({ to: '/sign-in', search: { redirect: location.href } }))(),
 */
export function createRequireAuth<
  TRouter extends AnyRouter,
  TFrom extends string,
  TTo extends string | undefined,
  TMaskFrom extends string,
  TMaskTo extends string,
>(prefetchSessionFn: SessionPrefetchFn, signIn: SignInRedirect<TRouter, TFrom, TTo, TMaskFrom, TMaskTo>) {
  return async function requireAuth() {
    const session = await prefetchSessionFn();
    if (!session) {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is thrown by design
      throw signIn();
    }
  };
}
