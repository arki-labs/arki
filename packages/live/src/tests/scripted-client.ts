/**
 * A scripted client for protocol tests: the client half of plan § 5 in a few
 * lines, with no transport. It keeps one cached result per live path, handles
 * `begin`/`change`/`gap`/`bye` exactly as the React provider will (a reset
 * refetches every query, a change refetches the affected paths, the cursor is
 * saved after handling), and refetches at once where TanStack would
 * invalidate. `stalePaths()` compares the cache with a fresh read.
 */
import type { LiveCursor, LiveFeed, LiveHub, LiveManifest } from '../index.js';
import { affectedPaths } from '../index.js';

export type LiveQuery = { readonly path: readonly string[]; read(): Promise<string> };

export type ScriptedClient = {
  /** `reset`, `resume`, `change`, `gap`, `bye` and `refused` (the hub was not ready), in order. */
  readonly log: string[];
  cursor(): LiveCursor | undefined;
  connected(): boolean;
  /** The first fetch, before any stream (SSR or a first render). */
  fetchAll(): Promise<void>;
  /** Opens a stream with the saved cursor, on `target` (another replica, a restarted server) or the client's hub; false when it refused. */
  connect(target?: LiveHub): Promise<boolean>;
  disconnect(): Promise<void>;
  /** Paths whose cached result differs from a fresh read. */
  stalePaths(): Promise<readonly string[]>;
};

export function scriptedClient(hub: LiveHub, manifest: LiveManifest, queries: readonly LiveQuery[]): ScriptedClient {
  const cache = new Map<string, string>();
  const log: string[] = [];
  const byPath = new Map(queries.map(query => [query.path.join('.'), query]));
  let cursor: LiveCursor | undefined;
  let controller: AbortController | undefined;
  let pump: Promise<void> | undefined;
  let open = false;

  async function refetch(path: readonly string[]): Promise<void> {
    const query = byPath.get(path.join('.'));
    if (query) cache.set(path.join('.'), await query.read());
  }

  async function handle(feed: LiveFeed): Promise<void> {
    switch (feed.kind) {
      case 'begin': {
        log.push(feed.mode);
        if (feed.mode === 'reset') for (const query of queries) await refetch(query.path);
        cursor = feed.cursor;
        return;
      }
      case 'change': {
        log.push('change');
        for (const path of affectedPaths(manifest, feed.tags)) await refetch(path);
        cursor = feed.cursor;
        return;
      }
      case 'gap':
      case 'bye': {
        log.push(feed.kind);
        return;
      }
    }
  }

  return {
    log,
    cursor: () => cursor,
    connected: () => open,
    async fetchAll() {
      for (const query of queries) await refetch(query.path);
    },
    async connect(target = hub) {
      const abort = new AbortController();
      let feed: AsyncIterable<LiveFeed>;
      try {
        feed = await target.open({ ...(cursor === undefined ? {} : { cursor }), signal: abort.signal });
      } catch {
        log.push('refused');
        return false;
      }
      controller = abort;
      open = true;
      pump = (async () => {
        for await (const item of feed) await handle(item);
        open = false;
      })();
      return true;
    },
    async disconnect() {
      controller?.abort();
      await pump;
      open = false;
    },
    async stalePaths() {
      const stale: string[] = [];
      for (const query of queries) {
        const key = query.path.join('.');
        if (cache.get(key) !== (await query.read())) stale.push(key);
      }
      return stale;
    },
  };
}
