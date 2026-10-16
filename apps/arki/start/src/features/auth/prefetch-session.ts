import { createServerFn } from '@tanstack/react-start';

import { getPrincipal } from './auth.server';

/**
 * Server function that resolves the principal for the current
 * request. Invoked from `__root.tsx`'s `beforeLoad` so the session lands in
 * the QueryClient cache before any component renders, eliminating the
 * `<AuthLoading>` skeleton on cold loads.
 *
 * Always returns the live principal (or `null`) — the cache freshness is
 * managed at the call site via `queryClient.getQueryData(['session'])`.
 */
export const prefetchSessionFn = createServerFn({ method: 'GET' }).handler(async () => getPrincipal());

export type SessionPrefetchResult = Awaited<ReturnType<typeof prefetchSessionFn>>;
