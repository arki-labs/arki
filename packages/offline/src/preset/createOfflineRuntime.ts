/// <reference path="../query/vite-env.d.ts" />
import type { DefaultOptions, QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createElement, Fragment } from 'react';

import type { AnyRpcClient, OfflineMutationQueue } from '../mutations/queue.ts';
import { OfflineDevPanel } from '../devtools/DevPanel.tsx';
import { OfflineQueueProvider } from '../mutations/OfflineQueueProvider.tsx';
import { createOfflineMutationQueue } from '../mutations/queue.ts';
import { createPersistedQueryClient } from '../query/createPersistedQueryClient.ts';
import { PersistedQueryClientProvider } from '../query/PersistedQueryClientProvider.tsx';

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
  queryClient: QueryClient;
  queue?: OfflineMutationQueue;
  Provider: (props: { children: ReactNode }) => ReactNode;
};

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
 *   appId: 'avocabo',
 *   rpc: rpcClient,
 *   actorId: () => signedInUserId, // your session state; `null` signed out, `undefined` not known yet
 *   devtools: true,
 * });
 * ```
 *
 * Then wire the Provider in your root provider:
 * ```tsx
 * <offline.Provider>
 *   <ORPCReactProvider client={rpcClient} queryClient={offline.queryClient}>
 *     {children}
 *   </ORPCReactProvider>
 * </offline.Provider>
 * ```
 */
export function createOfflineRuntime(config: OfflineRuntimeConfig): OfflineRuntime {
  const { appId, buster, devtools = false, queryDefaults } = config;

  const { queryClient, persister, maxAge } = createPersistedQueryClient({
    storageKey: `arki-offline-query:${appId}`,
    buster,
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

    // Outer: persisted query client provider
    content = createElement(PersistedQueryClientProvider, {
      client: queryClient,
      persister,
      maxAge,
      buster,
      children: content,
    });

    return content;
  }

  return { queryClient, queue, Provider };
}
