'use client';

import type { RouterClient } from '@orpc/server';
import type { appRouter } from '@arki/backend/api';
import type { ReactNode } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { PersistedQueryClientProvider } from '@arki/offline/query';

import { getBaseUrl } from '~/config';
import { createQueryClient } from './query-client';
import { idbPersister } from '~/lib/offline';

const link = new RPCLink({
  url: getBaseUrl() + '/api/orpc',
  headers: async () => ({}),
});

const client: RouterClient<typeof appRouter> = createORPCClient(link);

/**
 * oRPC TanStack Query utilities.
 * Use with standard TanStack Query hooks:
 *
 * @example
 * import { useQuery } from '@tanstack/react-query';
 * import { orpc } from '~/lib/orpc/client';
 *
 * const { data } = useQuery(orpc.auth.getProfile.queryOptions({ input: {} }));
 */
export const orpc = createTanstackQueryUtils(client);

// Client-side singleton. On the server, a fresh client is created per request
// inside the router's Wrap (see router.tsx). On the client this singleton is
// shared across all renders so the persisted IDB cache stays in sync.
let clientQueryClientSingleton: QueryClient | undefined;

function getClientQueryClient(): QueryClient {
  if (typeof window === 'undefined') {
    // Server: always fresh (never persisted — SSR doesn't write to IDB).
    return createQueryClient();
  }
  return (clientQueryClientSingleton ??= createQueryClient());
}

/**
 * Wraps the app with a QueryClient that has IDB persistence (Tier 1 offline).
 *
 * On the server, a passthrough client is created per render (no persistence).
 * On the client, a singleton QueryClient is paired with an IDB persister so
 * the query cache survives page reloads and short network outages.
 */
export function ORPCReactProvider({ children }: { children: ReactNode }) {
  const queryClient = getClientQueryClient();

  return (
    <PersistedQueryClientProvider client={queryClient} persister={idbPersister}>
      {children}
    </PersistedQueryClientProvider>
  );
}

/**
 * Returns the oRPC TanStack Query utilities for use inside React components.
 *
 * @example
 * const orpc = useORPC();
 * const mutation = useMutation(orpc.auth.updateProfile.mutationOptions());
 */
export function useORPC() {
  return orpc;
}
