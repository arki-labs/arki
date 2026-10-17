import { dehydrate, hydrate, QueryClientProvider } from '@tanstack/react-query';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';

import { RootErrorComponent } from '@fleet/tanstack-start/error';

import { createQueryClient } from './lib/orpc/query-client';
import { routeTree } from './routeTree.gen';

export function createRouter() {
  // Per-router-instance QueryClient. On the server this gives per-request
  // isolation (no session leakage between users); on the client this is the
  // single shared client for the app's lifetime because `getRouter()` is a
  // singleton there.
  const queryClient = createQueryClient();

  return createTanStackRouter({
    routeTree,
    defaultPreload: 'intent',
    scrollRestoration: true,
    scrollToTopSelectors: ['[data-scroll-restoration-id="sidebar-inset"]'],
    trailingSlash: 'preserve',
    // Subtle browser-native crossfade on every navigation. Keyframes ship from
    // @arki/design-systems/transitions/nav.css (imported in styles/global.css).
    // Falls back to instant swap in browsers without View Transitions.
    defaultViewTransition: { types: ['nav'] },
    defaultErrorComponent: RootErrorComponent,
    // Exposes the queryClient to every loader / beforeLoad via `context.queryClient`.
    // Routes that prefetch into this client during SSR populate the cache that
    // the dehydrate/hydrate callbacks below carry across the SSR boundary.
    context: { queryClient },
    // Wrap is the outermost provider — sits OUTSIDE every route component
    // including __root. Mounting QueryClientProvider here means the same
    // queryClient that loaders prefetch into is the one `useQuery`/`useSession`
    // read from on the client.
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
    // dehydrate runs at the end of SSR — its return value is serialized into
    // the HTML and piped to the client. We capture the queryClient state so
    // any prefetched queries (sessions, loaders, etc.) survive the SSR/CSR
    // boundary.
    //
    // Why the `Record<string, object>` cast: TanStack Router's
    // `ValidateSerializableInput` type rejects `readonly unknown[]` (the
    // shape of `DehydratedState['mutations'][n].mutationKey` in
    // @tanstack/react-query), demanding `readonly {}[]`. The runtime payload
    // is plain JSON-serializable data; this is a known type-level interop gap
    // between the two TanStack libraries. We launder the type through
    // `Record<string, object>` (which the router validator accepts) and
    // re-narrow on the hydrate side.
    dehydrate: (): Record<string, object> => ({ queryClient: dehydrate(queryClient) }),
    // hydrate runs once on the client during initial mount — replays the
    // serialized cache into the queryClient before any component renders.
    hydrate: (state: Record<string, object>) => {
      hydrate(queryClient, state['queryClient'] as Parameters<typeof hydrate>[1]);
    },
  });
}

// On the client, the router is a singleton (hydration only happens once).
// On the server, we must create a fresh router per request — a singleton would
// carry stale `state.redirect` across requests, causing infinite redirect loops.
let clientRouter: ReturnType<typeof createRouter> | undefined;

export function getRouter() {
  if (typeof document !== 'undefined') {
    if (!clientRouter) {
      clientRouter = createRouter();
    }
    return clientRouter;
  }
  return createRouter();
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
