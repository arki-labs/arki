'use client';

import type { RouterClient } from '@orpc/server';
import type { appRouter } from '@arki/backend/api';
import type { ReactNode } from 'react';
import { createORPCClient } from '@orpc/client';
import { RPCLink } from '@orpc/client/fetch';
import { useQueryClient } from '@tanstack/react-query';
import { createTanstackQueryUtils } from '@orpc/tanstack-query';
import { PersistedQueryClientProvider } from '@arki/offline/query';

import { getBaseUrl } from '~/config';
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

/**
 * Adds IDB persistence (Tier 1 offline) to the router's QueryClient, so the query cache survives page reloads and
 * short network outages.
 *
 * It reuses the client the router's `Wrap` provides (see router.tsx) instead of making its own: route `beforeLoad`s
 * prefetch into that client (the session, via `ensureSession`), and a second client here would hide that data from
 * every hook below it. The router makes one client per request on the server and one for the app's life in the browser.
 */
export function ORPCReactProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();

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
