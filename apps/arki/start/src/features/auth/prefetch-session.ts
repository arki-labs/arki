import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

import { auth } from './auth.server';

/**
 * Server function that resolves the better-auth session for the current
 * request. Invoked from `__root.tsx`'s `beforeLoad` so the session lands in
 * the QueryClient cache before any component renders, eliminating the
 * `<AuthLoading>` skeleton on cold loads.
 *
 * Always returns the live session (or `null`) — the cache freshness is
 * managed at the call site via `queryClient.getQueryData(['session'])`.
 */
export const prefetchSessionFn = createServerFn({ method: 'GET' }).handler(async () => {
  const request = getRequest();
  return auth.api.getSession({ headers: request.headers });
});

export type SessionPrefetchResult = Awaited<ReturnType<typeof prefetchSessionFn>>;
