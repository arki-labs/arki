import { QueryClient } from '@tanstack/react-query';

/**
 * Allow-list of queryKey hashes that survive the SSR → client dehydration.
 * Anything else refetches on the client. Two reasons we filter aggressively:
 *
 *  1. **First-paint correctness.** The `['session']` query drives `<SignedIn>`
 *     / `<SignedOut>` in the sidebar footer. Without dehydrating it, the
 *     client renders a loading skeleton until the session refetches and the
 *     auth UI flickers in.
 *
 *  2. **Other queries can crash dehydration.** oRPC query results sometimes
 *     reference React forwardRef components (icons in manifest data, etc.),
 *     which Seroval — TanStack Start's serializer — refuses to serialize.
 *     A blanket "dehydrate everything" pulls those refs into the SSR payload
 *     and the whole `dehydrate()` callback throws, which in turn prevents
 *     `window.$_TSR.router` from being injected. Result: a client-side
 *     `Invariant failed: Expected to find a dehydrated data on
 *     window.$_TSR.router`. Filtering keeps the boundary clean.
 *
 * Add new entries here only when a query's data is essential for first paint
 * AND known to be JSON-serializable (no React refs, no functions, no class
 * instances). Allow-list, not deny-list — every addition should be a
 * deliberate decision.
 */
const DEHYDRATABLE_QUERY_HASHES = new Set<string>(['["session"]']);

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        // With SSR, set some default staleTime to avoid refetching immediately on the client
        staleTime: 30 * 1000,
      },
      dehydrate: {
        shouldDehydrateQuery: (query) => DEHYDRATABLE_QUERY_HASHES.has(query.queryHash),
      },
    },
  });
