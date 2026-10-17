/**
 * The React provider (peers `react`, `@tanstack/react-query`): one stream per
 * tab that tells TanStack Query which queries to refetch.
 *
 * - `LiveProvider` opens the stream (in an effect, so never on the server) and
 *   turns frames into `invalidateQueries` calls by oRPC path: `hello` with
 *   `reset` invalidates every live path, `change` the paths whose tables
 *   changed. `[path]` matches every input of a procedure. A scoped table's
 *   change names its keys: a path whose scope comes from its input
 *   (`input.orgId`) refetches only the queries whose input holds one of them
 *   (compared the way Postgres prints the key kind; an input without the key
 *   refetches too), a `session`-scoped path refetches whole.
 * - `useLiveQuery(orpc.x.queryOptions({ input }))` is `useQuery` with three
 *   rules: no `initialData` (a reset would bring it back after a 401), no
 *   retry on 401/403, and a warning when its path is not in the manifest.
 *
 * Three cases the plain invalidation misses, handled here:
 *
 * - First-fetch race. TanStack Query does not cancel a query's first fetch
 *   (it has no data to keep), and the fetch's success clears the invalidated
 *   flag, so a hint that lands during it would be lost. Such a query is
 *   marked, and refetched once after that fetch succeeds.
 * - 401/403. A live query that errors with 401/403 while it still holds data
 *   is reset once (its data dropped). The reset's own refetch fails again
 *   with no data left, so it does not reset again: no loop.
 * - A shrinking grant. Paths that leave the manifest on a new `hello` are
 *   removed from the cache: their data was read under the old grant. So are
 *   the queries of keys the new `hello` no longer grants (a `session` path
 *   whole, when it lost any key); the queries of newly granted keys refetch.
 *
 * Server rendering: put `await hub.cursor()` in the page's query cache with
 * `setLiveCursor(queryClient, cursor)` before the page's data is read. It is
 * dehydrated with the rest; the provider connects with it, so the hub resumes
 * (replaying any commit since) instead of resetting and refetching everything.
 */
import type {
  DefaultError,
  Query,
  QueryClient,
  QueryKey,
  UseQueryOptions,
  UseQueryResult,
} from '@tanstack/react-query';
import type { ReactElement, ReactNode } from 'react';
import { createContext, createElement, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { LiveStatus } from './client.js';
import type { LiveCursor, LiveEvent, LiveKeyKind, LiveManifest, LiveReceipt } from './types.js';
import { createLiveClient } from './client.js';
import { debugReact } from './debug.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { tagKey } from './manifest.js';
import { parseLiveCursor } from './parse.js';
import { normalizeKey } from './scopes.js';

/** The query key that carries a server-rendered page's cursor to the client. */
const CURSOR_KEY = ['@arki/live', 'cursor'] as const;
/** Receipts remembered after their frame, so a write whose reply comes after its hint still resolves at once. */
const RECENT_TXIDS = 1024;
const DEFAULT_TXID_TIMEOUT_MS = 10_000;

type TxIdWaiter = { readonly resolve: () => void };

type Hello = Extract<LiveEvent, { kind: 'hello' }>;
type Change = Extract<LiveEvent, { kind: 'change' }>;
type Entry = LiveManifest[number];
/** Keys one grant gives one dimension: a list, `'all'`, or none. */
type Granted = string[] | 'all' | undefined;
/** Where a procedure takes a dimension's key from its input. */
type InputSource = { readonly path: readonly string[]; readonly kind: LiveKeyKind };

/** The value at `path` in a query's input (oRPC keys are `[path, { input }]`), or `undefined`. */
function inputAt(query: Query, path: readonly string[]): unknown {
  const options = query.queryKey[1];
  let value: unknown =
    typeof options === 'object' && options !== null && Object.hasOwn(options, 'input')
      ? Reflect.get(options, 'input')
      : undefined;
  for (const segment of path) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, segment)) return undefined;
    value = Reflect.get(value, segment);
  }
  return value;
}

/** A query's key for `source`, as Postgres prints it; `undefined` when its input holds none that compares. */
function queryKeyOf(query: Query, source: InputSource): string | undefined {
  const value = inputAt(query, source.path);
  if (typeof value === 'string') return normalizeKey(source.kind, value);
  if (typeof value === 'number' || typeof value === 'bigint') return normalizeKey(source.kind, String(value));
  return undefined;
}

function covers(granted: Granted, key: string): boolean {
  return granted === 'all' || (granted?.includes(key) ?? false);
}

/** Whether `after` leaves out any key `before` granted. */
function loses(before: Granted, after: Granted): boolean {
  if (before === undefined || after === 'all') return false;
  if (before === 'all') return true;
  return before.some(key => !covers(after, key));
}

/**
 * What a `change` refetches, per manifest entry that reads one of its tags: the whole path (an
 * unscoped table, a `session` scope, or a scope the entry does not declare, so it is live only for
 * `'all'` grants), or, per input-scoped dimension, the queries whose input holds a changed key.
 */
function targetsOf(
  manifest: LiveManifest,
  tags: Change['tags'],
): Map<Entry, { whole: boolean; readonly keys: Map<InputSource, Set<string>> }> {
  const targets = new Map<Entry, { whole: boolean; readonly keys: Map<InputSource, Set<string>> }>();
  for (const tag of tags) {
    const changed = tagKey(tag);
    for (const entry of manifest) {
      if (!entry.reads.some(read => tagKey(read) === changed)) continue;
      const target = targets.get(entry) ?? { whole: false, keys: new Map<InputSource, Set<string>>() };
      targets.set(entry, target);
      const source = tag.scope === undefined ? undefined : entry.scope?.[tag.scope.name];
      if (tag.scope === undefined || source === undefined || source.from === 'session') {
        target.whole = true;
        continue;
      }
      const keys = target.keys.get(source) ?? new Set<string>();
      target.keys.set(source, keys);
      for (const key of tag.scope.keys) keys.add(key);
    }
  }
  return targets;
}

/** One provider's state for one `QueryClient`. Internal. */
type LiveSession = {
  /** Properties, not methods: `useSyncExternalStore` takes them unbound. */
  readonly status: () => LiveStatus;
  setStatus(status: LiveStatus): void;
  readonly subscribe: (listener: () => void) => () => void;
  /** The last cursor handled: a remounted provider resumes from it. */
  cursor(): LiveCursor | undefined;
  receive(event: LiveEvent): void;
  /** A hook's key path (JSON of `queryKey[0]`); returns the unregister. */
  register(pathKey: string): () => void;
  /** Watches the query cache for the first-fetch race and for 401/403; returns the unsubscribe. */
  watch(): () => void;
  awaitTxId(receipt: LiveReceipt, timeoutMs: number): Promise<void>;
};

/** The live session of each `QueryClient` with a mounted provider. */
const sessions = new WeakMap<QueryClient, LiveSession>();

function isAuthError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'status' in error && (error.status === 401 || error.status === 403)
  );
}

function liveSession(queryClient: QueryClient, keyPrefix: readonly string[], initialCursor: LiveCursor | undefined) {
  let status: LiveStatus = 'connecting';
  let cursor = initialCursor;
  let manifest: LiveManifest | undefined;
  /** The stream's own keys per dimension, from the last `hello` (none: an app without scoped tables). */
  let granted: Hello['scopes'];
  /** JSON of each manifest path's key (`[...keyPrefix, ...path]`). */
  let manifestKeys = new Set<string>();
  const listeners = new Set<() => void>();
  /** How many mounted hooks use each key path. */
  const registered = new Map<string, number>();
  const warned = new Set<string>();
  /** Queries a hint reached during their first fetch: refetch once after it. */
  const dirty = new WeakSet<Query>();
  const waiters = new Map<string, Set<TxIdWaiter>>();
  const recentTxIds = new Set<string>();

  const keyOf = (path: readonly string[]): readonly string[] => [...keyPrefix, ...path];

  /** Invalidates the path's queries (those `predicate` picks, when given), marking those in their first fetch. */
  function invalidate(path: readonly string[], predicate?: (query: Query) => boolean): void {
    const filters = { queryKey: [keyOf(path)], ...(predicate === undefined ? {} : { predicate }) };
    for (const query of queryClient.getQueryCache().findAll(filters)) {
      if (query.state.data === undefined && query.state.fetchStatus === 'fetching') dirty.add(query);
    }
    void queryClient.invalidateQueries(filters);
  }

  function changed(tags: Change['tags']): void {
    for (const [entry, target] of targetsOf(manifest ?? [], tags)) {
      if (target.whole) {
        invalidate(entry.path);
        continue;
      }
      // An input without a comparable key refetches too: a false refetch over silent staleness.
      invalidate(entry.path, query =>
        [...target.keys].some(([source, keys]) => {
          const key = queryKeyOf(query, source);
          return key === undefined || keys.has(key);
        }),
      );
    }
  }

  /**
   * The grant moved: per dimension an entry is scoped by, drop the queries of keys it lost (read
   * under the old grant) and, on a resume, refetch those of keys it gained (never tracked). A
   * `session` path is dropped whole when it lost any key, refetched when it only gained.
   */
  function regrant(before: Hello['scopes'], after: Hello['scopes'], resume: boolean): void {
    for (const entry of manifest ?? []) {
      for (const [dimension, source] of Object.entries(entry.scope ?? {})) {
        const was = before?.[dimension];
        const is = after?.[dimension];
        if (JSON.stringify(was) === JSON.stringify(is)) continue;
        const queryKey = [keyOf(entry.path)];
        if (source.from === 'session') {
          if (loses(was, is)) queryClient.removeQueries({ queryKey });
          else if (resume) invalidate(entry.path);
          continue;
        }
        queryClient.removeQueries({
          queryKey,
          predicate: query => {
            const key = queryKeyOf(query, source);
            return key !== undefined && covers(was, key) && !covers(is, key);
          },
        });
        if (resume) {
          invalidate(entry.path, query => {
            const key = queryKeyOf(query, source);
            return key === undefined || (covers(is, key) && !covers(was, key));
          });
        }
      }
    }
  }

  function checkRegistered(pathKey: string): void {
    if (manifest === undefined || manifestKeys.has(pathKey) || warned.has(pathKey)) return;
    warned.add(pathKey);
    debugReact.warn(
      '[{code}] useLiveQuery() on {path}, which is not in the live manifest: it will never refresh. Give the procedure live() meta (a query, not a mutation), check the grant, or use useQuery().',
      { code: LIVE_ERROR_CODES.config, path: pathKey },
    );
  }

  function settleTxIds(txids: readonly string[]): void {
    for (const txid of txids) {
      recentTxIds.delete(txid);
      recentTxIds.add(txid);
      for (const waiter of waiters.get(txid) ?? []) waiter.resolve();
    }
    for (const oldest of recentTxIds) {
      if (recentTxIds.size <= RECENT_TXIDS) break;
      recentTxIds.delete(oldest);
    }
  }

  function hello(event: Hello): void {
    const previous = manifest;
    const previousKeys = manifestKeys;
    const previousGrant = granted;
    manifest = event.manifest;
    granted = event.scopes;
    manifestKeys = new Set(event.manifest.map(entry => JSON.stringify(keyOf(entry.path))));
    if (previous !== undefined) {
      // Read under the old grant: drop what this client may no longer see.
      for (const entry of previous) {
        if (!manifestKeys.has(JSON.stringify(keyOf(entry.path))))
          queryClient.removeQueries({ queryKey: [keyOf(entry.path)] });
      }
      regrant(previousGrant, granted, event.mode === 'resume');
    }
    if (event.mode === 'reset') {
      for (const entry of event.manifest) invalidate(entry.path);
      // Every live query refetches: a write being awaited is covered.
      for (const set of waiters.values()) for (const waiter of set) waiter.resolve();
    } else if (previous !== undefined) {
      // A path new to the manifest was never tracked: its cached data has unknown age.
      for (const entry of event.manifest) {
        if (!previousKeys.has(JSON.stringify(keyOf(entry.path)))) invalidate(entry.path);
      }
    }
    for (const pathKey of registered.keys()) checkRegistered(pathKey);
  }

  const session: LiveSession = {
    status: () => status,
    setStatus(next) {
      status = next;
      for (const listener of listeners) listener();
    },
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    cursor: () => cursor,

    receive(event) {
      switch (event.kind) {
        case 'hello': {
          hello(event);
          cursor = event.cursor;
          return;
        }
        case 'change': {
          changed(event.tags);
          settleTxIds(event.txids);
          cursor = event.cursor;
          return;
        }
        default: {
          return;
        }
      }
    },

    register(pathKey) {
      registered.set(pathKey, (registered.get(pathKey) ?? 0) + 1);
      checkRegistered(pathKey);
      return () => {
        const count = (registered.get(pathKey) ?? 1) - 1;
        if (count === 0) registered.delete(pathKey);
        else registered.set(pathKey, count);
      };
    },

    watch() {
      return queryClient.getQueryCache().subscribe(event => {
        if (event.type !== 'updated') return;
        const { query, action } = event;
        if (action.type === 'success' && dirty.has(query)) {
          dirty.delete(query);
          // After TanStack finishes its own success handling.
          queueMicrotask(() => void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }));
          return;
        }
        if (action.type !== 'error') return;
        dirty.delete(query);
        const pathKey = JSON.stringify(query.queryKey[0]);
        const live = manifestKeys.has(pathKey) || registered.has(pathKey);
        // Only while it still holds data: the reset empties it, so the reset's own failed refetch stops here.
        if (live && isAuthError(action.error) && query.state.data !== undefined) {
          queueMicrotask(() => void queryClient.resetQueries({ queryKey: query.queryKey, exact: true }));
        }
      });
    },

    awaitTxId(txid, timeoutMs) {
      if (recentTxIds.has(txid)) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const set = waiters.get(txid) ?? new Set<TxIdWaiter>();
        waiters.set(txid, set);
        const forget = (): void => {
          clearTimeout(timer);
          set.delete(waiter);
          if (set.size === 0) waiters.delete(txid);
        };
        const waiter: TxIdWaiter = {
          resolve() {
            forget();
            resolve();
          },
        };
        const timer = setTimeout(() => {
          forget();
          reject(
            liveError(
              LIVE_ERROR_CODES.limit,
              `awaitTxId(${txid}): no change frame named this receipt within ${timeoutMs} ms`,
              'Check that the mutation returns receipts.of(pg_current_xact_id()::text) of its own transaction, that the hub has the same receipts (app and secret), and that the stream is live; or refetch instead.',
            ),
          );
        }, timeoutMs);
        set.add(waiter);
      });
    },
  };
  return session;
}

const LiveContext = createContext<LiveSession | undefined>(undefined);

function useSession(hook: string): LiveSession {
  const session = useContext(LiveContext);
  if (session === undefined) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${hook} outside <LiveProvider>`,
      'Render <LiveProvider> inside <QueryClientProvider>, around every component that uses live queries.',
    );
  }
  return session;
}

export type LiveProviderProps = {
  /** The stream. Default `/api/live`. */
  readonly url?: string | URL;
  /**
   * Read before every connect, so the latest function is always used and a new one (an inline
   * arrow) does not reconnect. After a 401/403 the provider tries again when this function changes.
   */
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
  readonly fetch?: typeof globalThis.fetch;
  /** The `path` the oRPC utils were built with (`createTanstackQueryUtils(client, { path })`), if any. */
  readonly keyPrefix?: readonly string[];
  readonly children?: ReactNode;
};

/** One live stream for the `QueryClient` above it. A second provider for the same client logs E001. */
export function LiveProvider(props: LiveProviderProps): ReactElement {
  const queryClient = useQueryClient();
  const { url = '/api/live', headers, fetch } = props;
  const [session] = useState(() =>
    liveSession(queryClient, props.keyPrefix ?? [], parseLiveCursor(queryClient.getQueryData(CURSOR_KEY))),
  );
  /** Bumped to retry after a 401/403 once `headers` changed. */
  const [attempt, setAttempt] = useState(0);
  const latestHeaders = useRef(headers);

  useEffect(() => {
    latestHeaders.current = headers;
    if (session.status() === 'unauthorized') setAttempt(count => count + 1);
  }, [session, headers]);

  useEffect(() => {
    const other = sessions.get(queryClient);
    if (other !== undefined && other !== session) {
      debugReact.error('[{code}] a second <LiveProvider> for one QueryClient: it opens a second stream', {
        code: LIVE_ERROR_CODES.config,
      });
    }
    sessions.set(queryClient, session);
    const unwatch = session.watch();
    return () => {
      unwatch();
      if (sessions.get(queryClient) === session) sessions.delete(queryClient);
    };
  }, [queryClient, session]);

  useEffect(() => {
    const cursor = session.cursor();
    const client = createLiveClient({
      url,
      headers: async () => (await latestHeaders.current?.()) ?? {},
      ...(fetch === undefined ? {} : { fetch }),
      ...(cursor === undefined ? {} : { cursor }),
      onEvent: event => session.receive(event),
      onStatus: status => session.setStatus(status),
    });
    client.start();
    return () => client.stop();
  }, [session, url, fetch, attempt]);

  return createElement(LiveContext.Provider, { value: session }, props.children);
}

/** The stream's status, for an "offline" badge. */
export function useLiveStatus(): LiveStatus {
  const session = useSession('useLiveStatus()');
  return useSyncExternalStore(session.subscribe, session.status, () => 'connecting');
}

/**
 * `useQuery` for a live procedure: pass the options oRPC builds,
 * `useLiveQuery(orpc.posts.list.queryOptions({ input }))`. Types come from
 * oRPC and TanStack. `initialData` is rejected (a 401 reset would restore it);
 * use `placeholderData`. 401/403 is never retried.
 */
export function useLiveQuery<
  TQueryFnData = unknown,
  TError = DefaultError,
  TData = TQueryFnData,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey> & { readonly initialData?: never },
): UseQueryResult<TData, TError> {
  const session = useSession('useLiveQuery()');
  const pathKey = JSON.stringify(options.queryKey[0]);
  useEffect(() => session.register(pathKey), [session, pathKey]);
  const retry = options.retry;
  return useQuery({
    ...options,
    retry: (failureCount, error) => {
      if (isAuthError(error)) return false;
      if (typeof retry === 'function') return retry(failureCount, error);
      if (typeof retry === 'number') return failureCount < retry;
      return retry ?? failureCount < 3;
    },
  });
}

/**
 * Puts a server-rendered page's cursor into its query cache, to be dehydrated
 * with the page. On the server: `setLiveCursor(queryClient, await hub.cursor())`
 * before the page's data is read. `undefined` (the hub is not ready) sets
 * nothing, and the client resets as usual.
 */
export function setLiveCursor(queryClient: QueryClient, cursor: LiveCursor | undefined): void {
  if (cursor !== undefined) queryClient.setQueryData(CURSOR_KEY, cursor);
}

/**
 * Resolves once a `change` frame names `receipt` (or a reset refetched every
 * live query), so the caller knows its own write is on its way into the cache.
 * `receipt` is what the mutation returned: `receipts.of(txid)` of its own
 * transaction, never the raw id.
 * Rejects with E006 after `timeoutMs` (default 10 000), and with E001 when no
 * `LiveProvider` is mounted for `queryClient`.
 */
export function awaitTxId(
  queryClient: QueryClient,
  receipt: LiveReceipt,
  options: { readonly timeoutMs?: number } = {},
): Promise<void> {
  const session = sessions.get(queryClient);
  if (session === undefined) {
    return Promise.reject(
      liveError(
        LIVE_ERROR_CODES.config,
        'awaitTxId() for a QueryClient with no mounted <LiveProvider>',
        'Mount <LiveProvider> inside the QueryClientProvider of this client.',
      ),
    );
  }
  return session.awaitTxId(receipt, options.timeoutMs ?? DEFAULT_TXID_TIMEOUT_MS);
}
