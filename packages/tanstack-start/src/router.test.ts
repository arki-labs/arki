import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRootRouteWithContext } from '@tanstack/react-router';
import { describe, expect, it } from 'vitest';

import { createQueryClient, createRouter } from './router';

type AppContext = { queryClient?: QueryClient; tenant?: string };

const createTypedRoot = () => createRootRouteWithContext<AppContext>()();

describe('createRouter', () => {
  it('preloads on intent with short delay and a 30s stale time unless told otherwise', () => {
    const router = createRouter({ routeTree: createRootRoute() });

    expect(router.options.defaultPreload).toBe('intent');
    expect(router.options.defaultPreloadDelay).toBe(50);
    expect(router.options.defaultPreloadStaleTime).toBe(30_000);
  });

  it('lets the app override the preload defaults, including turning preload off', () => {
    const router = createRouter({
      routeTree: createRootRoute(),
      defaultPreload: false,
      defaultPreloadDelay: 0,
      defaultPreloadStaleTime: 0,
    });

    expect(router.options.defaultPreload).toBe(false);
    expect(router.options.defaultPreloadDelay).toBe(0);
    expect(router.options.defaultPreloadStaleTime).toBe(0);
  });

  it('always restores scroll position', () => {
    expect(createRouter({ routeTree: createRootRoute() }).options.scrollRestoration).toBe(true);
  });

  it('puts the query client into the route context so loaders can reach it', () => {
    const queryClient = createQueryClient();
    const router = createRouter({ routeTree: createTypedRoot(), queryClient });

    expect(router.options.context).toEqual({ queryClient });
    expect(router.options.context?.queryClient).toBe(queryClient);
  });

  it('merges extra context next to the query client, and extra context wins on a clash', () => {
    const queryClient = createQueryClient();
    const replacement = createQueryClient();
    const router = createRouter({
      routeTree: createTypedRoot(),
      queryClient,
      context: { tenant: 'acme', queryClient: replacement },
    });

    expect(router.options.context?.tenant).toBe('acme');
    expect(router.options.context?.queryClient).toBe(replacement);
  });

  it('passes history and basepath through to the router', () => {
    const history = createMemoryHistory({ initialEntries: ['/docs'] });
    const router = createRouter({ routeTree: createRootRoute(), history, basepath: '/app' });

    expect(router.history).toBe(history);
    expect(router.options.basepath).toBe('/app');
  });

  it('two routers built for two requests do not share context', () => {
    const first = createRouter({ routeTree: createTypedRoot(), queryClient: createQueryClient() });
    const second = createRouter({ routeTree: createTypedRoot(), queryClient: createQueryClient() });

    expect(first.options.context?.queryClient).not.toBe(second.options.context?.queryClient);
  });
});

describe('createQueryClient', () => {
  it('returns a new QueryClient on every call, so one request never sees another request data', () => {
    const first = createQueryClient();
    const second = createQueryClient();

    expect(first).toBeInstanceOf(QueryClient);
    expect(first).not.toBe(second);
    expect(first.getQueryCache()).not.toBe(second.getQueryCache());
  });

  it('keeps cached data private to one client', () => {
    const first = createQueryClient();
    const second = createQueryClient();

    first.setQueryData(['session'], { user: 'alice' });

    expect(first.getQueryData(['session'])).toEqual({ user: 'alice' });
    expect(second.getQueryData(['session'])).toBeUndefined();
  });

  it('keeps SSR-friendly defaults: 1 minute stale time, no refetch on focus, one retry', () => {
    const { queries, mutations } = createQueryClient().getDefaultOptions();

    expect(queries?.staleTime).toBe(60_000);
    expect(queries?.refetchOnWindowFocus).toBe(false);
    expect(queries?.retry).toBe(1);
    expect(mutations?.retry).toBe(1);
  });
});
