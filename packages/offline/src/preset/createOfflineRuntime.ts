import type { DefaultOptions } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { isServer, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, Fragment, useState } from 'react';

import type { AnyRpcClient, OfflineMutationQueue } from '../mutations/queue.js';
import { OfflineDevPanel } from '../devtools/DevPanel.js';
import { OfflineQueueProvider } from '../mutations/OfflineQueueProvider.js';
import { createOfflineMutationQueue } from '../mutations/queue.js';
import type { QueryCachePersistFailed } from '../query/failures.js';
import { createPersistedQueryClient } from '../query/createPersistedQueryClient.js';
import { PersistedQueryClientProvider } from '../query/PersistedQueryClientProvider.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CacheOnlyConfig = {
  tier: 'cache-only';
  appId: string;
  buster?: string;
  devtools?: boolean;
  /** Forwarded to the underlying QueryClient — wire SuperJSON / staleTime / dehydration filters here. */
  queryDefaults?: DefaultOptions;
};

export type QueueConfig = {
  tier: 'queue';
  appId: string;
  rpc: AnyRpcClient;
  /** Who is signed in now (`null`: signed out; `undefined`: not known yet). Queued writes replay only under the actor that queued them. */
  actorId: () => string | null | undefined;
  buster?: string;
  devtools?: boolean;
  /** Forwarded to the underlying QueryClient — wire SuperJSON / staleTime / dehydration filters here. */
  queryDefaults?: DefaultOptions;
};

export type OfflineRuntimeConfig = CacheOnlyConfig | QueueConfig;

export type OfflineRuntime = {
  /**
   * The browser's one persisted QueryClient. Browser only: reading it on the server throws, because a
   * module-level client there would be one cache shared by every request. On the server each render of
   * `Provider` gets its own client; read it with `useQueryClient()`.
   */
  queryClient: QueryClient;
  /**
   * Writes the persisted query cache to IndexedDB now and resolves when it is stored. After removing
   * a query that must not come back (a deleted item), await it before the page can reload: the
   * automatic writes are throttled to one a second. Resolves `offline.query_cache_persist_failed` when
   * IndexedDB refuses the write. Browser only: on the server it rejects.
   */
  persistNow: () => Promise<void | ReturnType<typeof QueryCachePersistFailed>>;
  queue?: OfflineMutationQueue;
  /** Stops the queue's replay loop and removes its window listeners. Call it when the runtime is torn down (tests, hot reload). */
  dispose: () => void;
  /** In the browser: the persisted client. On the server: a fresh client for each request, never persisted. */
  Provider: (props: { children: ReactNode }) => ReactNode;
};

function browserOnly(member: string): Error {
  return new Error(
    `@arki/offline: offline.${member} exists only in the browser. On the server every request gets its own ` +
      'QueryClient inside <offline.Provider>; read it with useQueryClient().',
  );
}

/**
 * One QueryClient per server render, so no request reads another request's cache. `gcTime: Infinity`
 * is TanStack Query's server default: no garbage-collection timers, so the cache is freed with the
 * request. The persisted cache's 24-hour `gcTime` is for the browser and would keep each request's
 * data in memory for a day.
 */
function RequestQueryClientProvider(props: { defaultOptions?: DefaultOptions; children: ReactNode }): ReactNode {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          ...props.defaultOptions,
          queries: { ...props.defaultOptions?.queries, gcTime: Number.POSITIVE_INFINITY },
        },
      }),
  );
  return createElement(QueryClientProvider, { client: queryClient, children: props.children });
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a fully-wired offline runtime in a single call.
 *
 * Tier 'cache-only' (Tier 1): persisted QueryClient only.
 * Reads survive page reloads and short network outages.
 * Use this as the default for most apps.
 *
 * Tier 'queue' (Tier 2): persisted QueryClient + OfflineMutationQueue.
 * Writes made while offline are queued and replayed on reconnect.
 * Only use this in apps where write durability during offline sessions matters.
 *
 * @example — template usage (Tier 1):
 * ```ts
 * // src/lib/offline.ts
 * import { createOfflineRuntime } from '@arki/offline/preset';
 * import { rpcClient } from './orpc/client';
 *
 * export const offline = createOfflineRuntime({
 *   tier: 'cache-only',
 *   appId: 'myapp',
 *   devtools: true,
 * });
 * ```
 *
 * @example — Tier 2 with mutation queue:
 * ```ts
 * export const offline = createOfflineRuntime({
 *   tier: 'queue',
 *   appId: 'shop',
 *   rpc: rpcClient,
 *   actorId: () => signedInUserId, // your session state; `null` signed out, `undefined` not known yet
 *   devtools: true,
 * });
 * ```
 *
 * Then wire the Provider in your root provider. Components read the client with `useQueryClient()`:
 * ```tsx
 * <offline.Provider>{children}</offline.Provider>
 * ```
 *
 * In the browser, `Provider` uses one persisted QueryClient (`offline.queryClient`). On the server
 * (SSR) this module serves every request, so `Provider` makes a fresh, unpersisted client for each
 * request instead, and `offline.queryClient` throws there.
 */
export function createOfflineRuntime(config: OfflineRuntimeConfig): OfflineRuntime {
  const { appId, devtools = false, queryDefaults } = config;

  // Browser only: on the server one module-level client would be a cache shared by every request.
  const persisted = isServer
    ? undefined
    : createPersistedQueryClient({
        storageKey: `arki-offline-query:${appId}`,
        buster: config.buster,
        defaultOptions: queryDefaults,
      });

  let queue: OfflineMutationQueue | undefined;

  if (config.tier === 'queue') {
    queue = createOfflineMutationQueue({
      storageKey: `arki-offline-mutations:${appId}`,
      deadLetterStorageKey: `arki-offline-mutations-dead:${appId}`,
      rpc: config.rpc,
      actorId: config.actorId,
    });
  }

  function Provider({ children }: { children: ReactNode }): ReactNode {
    let content: ReactNode = children;

    // Dev panel floats visually, but must stay inside the queue provider when
    // tier 'queue' is enabled so it can inspect queued/dead-lettered writes.
    if (devtools) {
      content = createElement(Fragment, null, content, createElement(OfflineDevPanel));
    }

    // Innermost: queue provider (only in tier 'queue')
    if (queue) {
      content = createElement(OfflineQueueProvider, { queue, children: content });
    }

    // Outer: the query client provider. On the server, a fresh client for this request.
    if (!persisted) {
      return createElement(RequestQueryClientProvider, { defaultOptions: queryDefaults, children: content });
    }

    return createElement(PersistedQueryClientProvider, {
      client: persisted.queryClient,
      persister: persisted.persister,
      maxAge: persisted.maxAge,
      buster: persisted.buster,
      children: content,
    });
  }

  return {
    get queryClient() {
      if (!persisted) throw browserOnly('queryClient');
      return persisted.queryClient;
    },
    persistNow: () => (persisted ? persisted.persistNow() : Promise.reject(browserOnly('persistNow()'))),
    queue,
    dispose: () => queue?.dispose(),
    Provider,
  };
}
