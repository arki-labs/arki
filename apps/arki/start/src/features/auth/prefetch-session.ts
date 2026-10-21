import type { QueryClient } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';

import { getPrincipal } from './auth.server';

/**
 * Server function that resolves the principal for the current
 * request. Invoked from the signed-in layouts' `beforeLoad` (via `ensureSession`) so the session lands in
 * the QueryClient cache before any component renders, eliminating the
 * `<AuthLoading>` skeleton on cold loads.
 *
 * Always returns the live principal (or `null`) — the cache freshness is
 * managed at the call site via `queryClient.getQueryData(['session'])`.
 */
export const prefetchSessionFn = createServerFn({ method: 'GET' }).handler(async () => getPrincipal());

export type SessionPrefetchResult = Awaited<ReturnType<typeof prefetchSessionFn>>;

/**
 * Populates the better-auth session in the QueryClient before any component renders. On initial SSR the cache is
 * empty and we fetch directly via the server function. On client navigations the dehydrated cache already contains
 * the session — the guard short-circuits and useSession()'s own refresh logic takes over.
 */
export async function ensureSession(queryClient: QueryClient) {
  if (queryClient.getQueryData(['session']) !== undefined) return;
  const session = await prefetchSessionFn();
  queryClient.setQueryData(['session'], session);
}
