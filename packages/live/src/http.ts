/**
 * `@arki/live/http` (peer `@arki/http`): the SSE stream, `GET /api/live`.
 *
 * What a request goes through, in this order, all before any stream header:
 *
 * 1. The `cursor` query parameter: absent, or exactly one well-formed cursor
 *    (else 400 E004).
 * 2. `authorize(request)`: `null` answers 401 E005.
 * 3. The grant picks what this client may see: the manifest entries whose
 *    every table it may read, and the tables whose hints it gets. A scoped
 *    table shows only the keys the grant lists for its dimension (`'all'`:
 *    every key); a procedure reading it stays in the manifest when the grant
 *    has `'all'` for that dimension, or has keys and the procedure declares
 *    where its key comes from (`scope`). A dimension the grant leaves out
 *    shows nothing: closed by default.
 * 4. The stream attaches to the hub (503 E003 while the hub is not ready). A
 *    well-formed cursor the hub cannot open (another hub's, changed, expired)
 *    is not an error: the stream starts with a reset.
 *
 * Then `hello`, the replay or reset, and live `change` frames. The grant goes
 * into the hub with the stream, and the hub applies it to every hint before
 * the stream's batch window, queue and frame split (`hub.ts`): a frame holds
 * only granted tables and the receipts of transactions that wrote one of
 * them, and a hidden write changes nothing the stream shows, not even its
 * timing or when it gets `bye`. A client must not learn how often a table it
 * cannot read is written. After `maxAgeMs` the stream sends `bye` and ends,
 * so the client reconnects and is authorized again. Sooner for a frame that
 * names a `reauthorize` table (memberships): `authorize` runs again before
 * the frame goes out, and when the grant changed the stream sends `bye`
 * instead, so the client resumes from its last cursor under the new grant.
 */
import { z } from 'zod';

import type { RouteBundle, SseContract } from '@arki/http';
import { buildEngine, HttpError, optional, route, routes } from '@arki/http';

import type { LiveFeed, LiveGrant, LiveHub, LiveView } from './hub.js';
import type { LiveEvent, LiveManifest, LiveScopes, TableTag } from './types.js';
import { debugHttp } from './debug.js';
import { isLiveError, LIVE_ERROR_CODES, liveError } from './errors.js';
import { tagKey } from './manifest.js';
import { liveCursorSchema, liveEventSchema, MAX_GRANT_KEYS, scopeKeySchema, tableTagSchema } from './schema.js';
import { checkScopes, normalizeKey } from './scopes.js';

/** What `authorize` grants a client: its tables (omitted: every table of the manifest) and its keys per scope dimension. */
export type { LiveGrant } from './hub.js';

/** The stream's contract: one optional cursor in, `LiveEvent` frames out, a heartbeat every 15 s (under Cloudflare's 100 s idle cap). */
const liveRoute = route.sse('/api/live', {
  id: 'live.stream',
  summary: 'Live query hints: which tables changed, as server-sent events',
  query: { cursor: optional(liveCursorSchema) },
  event: liveEventSchema,
  heartbeatMs: 15_000,
});

export type LiveEndpoint = {
  /** `GET /api/live`, for clients and OpenAPI. */
  readonly contract: SseContract<'/api/live'>;
  /** For `http({ bundles })` in a Dot app (`liveQueries` publishes it as `liveRoutes`). */
  readonly routes: RouteBundle;
  /** For a TanStack Start route: `GET: ({ request }) => endpoint.fetch(request)`. */
  readonly fetch: (request: Request) => Promise<Response>;
};

const optionsSchema = z.object({
  /** After this long the stream sends `bye`, so the client is authorized again. */
  maxAgeMs: z.int().positive().default(300_000),
});

type Hello = Extract<LiveEvent, { kind: 'hello' }>;

/**
 * What one client may see: its part of the manifest, the view the hub applies, its own keys (for
 * `hello`), and a fingerprint that is equal for two grants exactly when they show the same.
 */
type View = {
  readonly manifest: LiveManifest;
  readonly hub: LiveView;
  readonly scopes: Hello['scopes'];
  readonly fingerprint: string;
};

/** E001 for a grant `authorize` should never give. */
function badGrant(problem: string, remediation: string): never {
  throw liveError(LIVE_ERROR_CODES.config, `liveEndpoint(): authorize() granted ${problem}`, remediation);
}

/** The cursor of a request: none, or exactly one that parses. Anything else is a 400 before the stream opens. */
function checkCursor(url: URL): void {
  const cursors = url.searchParams.getAll('cursor');
  const [cursor] = cursors;
  if (cursors.length === 0 || (cursors.length === 1 && liveCursorSchema.safeParse(cursor).success)) return;
  throw new HttpError(400, LIVE_ERROR_CODES.protocol, `malformed cursor ${JSON.stringify(cursors.join(','))}`, {
    remediation: 'Send back one cursor exactly as a frame gave it, or none.',
  });
}

/** The hub's refusals as HTTP answers; anything else is not ours to map. */
function toHttpError(error: unknown): unknown {
  if (!isLiveError(error)) return error;
  const options = { remediation: error.remediation };
  if (error.code === LIVE_ERROR_CODES.source) {
    return new HttpError(503, error.code, error.message, { ...options, headers: { 'retry-after': '1' } });
  }
  if (error.code === LIVE_ERROR_CODES.protocol) return new HttpError(400, error.code, error.message, options);
  return error;
}

/** Hub frames to wire frames for one client. `end` detaches it (idempotent). */
async function* framesFor(
  feed: AsyncIterable<LiveFeed>,
  view: View,
  stream: {
    readonly expired: () => boolean;
    readonly end: () => void;
    /** Whether a frame names a `reauthorize` table, and whether the request's grant still shows the same. */
    readonly recheck: {
      readonly needed: (tags: readonly TableTag[]) => boolean;
      readonly same: () => Promise<boolean>;
    };
  },
): AsyncGenerator<LiveEvent, void, undefined> {
  const { expired, end, recheck } = stream;
  try {
    for await (const item of feed) {
      switch (item.kind) {
        case 'begin': {
          yield {
            kind: 'hello',
            v: 1,
            mode: item.mode,
            cursor: item.cursor,
            manifest: view.manifest,
            ...(view.scopes === undefined ? {} : { scopes: view.scopes }),
          };
          break;
        }
        case 'change': {
          // Before the frame goes out: the client keeps the cursor before it, and resumes from there under the new grant.
          if (recheck.needed(item.tags) && !(await recheck.same())) {
            debugHttp.debug('a reauthorize table changed and so did the grant; sending bye');
            yield { kind: 'bye' };
            return;
          }
          // Already through the grant: the hub sends only what this view shows.
          yield item;
          break;
        }
        default: {
          yield item;
          return;
        }
      }
    }
    // The hub ended the feed without a frame: either the max age passed, or the request is gone.
    if (expired()) yield { kind: 'bye' };
  } finally {
    end();
  }
}

/**
 * The live stream as an `@arki/http` route bundle and a plain fetch handler.
 * `manifest` is the app's (`liveManifest(contract, { scopes })`); `scopes`
 * the same declaration (`liveScopes`), which types the grant's dimensions;
 * `authorize` sees the request before any header is sent. `reauthorize`
 * lists the tables whose change may change a grant (memberships): a frame
 * naming one runs `authorize` again (see the module comment). Its hints
 * reach a client like any granted table's, so scope it by user.
 */
export function liveEndpoint<Dimension extends string = never>(options: {
  readonly hub: LiveHub;
  readonly manifest: LiveManifest;
  readonly scopes?: LiveScopes<Dimension>;
  readonly authorize: (request: Request) => Promise<LiveGrant<NoInfer<Dimension>> | null>;
  readonly reauthorize?: readonly TableTag[];
  readonly maxAgeMs?: number;
}): LiveEndpoint {
  const where = 'liveEndpoint()';
  const parsed = optionsSchema.safeParse({ maxAgeMs: options.maxAgeMs });
  if (!parsed.success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `${where}: bad maxAgeMs: ${parsed.error.message}`,
      'maxAgeMs is a positive integer of milliseconds (default 300 000).',
    );
  }
  const { maxAgeMs } = parsed.data;
  const { hub, manifest } = options;
  const { kinds, byTag } = checkScopes(options.scopes, where);
  const reauthorize = new Map<string, TableTag>();
  for (const tag of options.reauthorize ?? []) {
    if (!tableTagSchema.safeParse(tag).success) {
      throw liveError(
        LIVE_ERROR_CODES.config,
        `${where}: bad reauthorize table ${JSON.stringify(tag)}`,
        'List { schema, table } tags: tableTag(memberships) from @arki/live/drizzle.',
      );
    }
    reauthorize.set(tagKey(tag), { schema: tag.schema, table: tag.table });
  }
  /** Every table this endpoint can show: the manifest's reads, then the `reauthorize` tables. */
  const known = new Map(manifest.flatMap(entry => entry.reads.map(read => [tagKey(read), read] as const)));
  for (const [key, tag] of reauthorize) if (!known.has(key)) known.set(key, tag);
  for (const entry of manifest) {
    for (const read of entry.reads) {
      const scoped = byTag.get(tagKey(read));
      if (scoped !== undefined && entry.scope?.[scoped.dimension] === undefined) {
        debugHttp.warn(
          '[{code}] {path} reads {table}, scoped by {dimension}, without declaring scope.{dimension}: it is live only for grants with {dimension}: all',
          {
            code: LIVE_ERROR_CODES.config,
            path: entry.path.join('.'),
            table: `${read.schema}.${read.table}`,
            dimension: scoped.dimension,
          },
        );
      }
    }
  }

  /** The grant's keys per dimension: each normalized, deduplicated and sorted, or `'all'`. E001 for a grant that cannot be right. */
  function keysOf(scopes: LiveGrant['scopes']): ReadonlyMap<string, readonly string[] | 'all'> {
    const keys = new Map<string, readonly string[] | 'all'>();
    for (const [dimension, granted] of Object.entries(scopes ?? {})) {
      if (granted === undefined) continue;
      const kind = kinds.get(dimension);
      if (kind === undefined) {
        badGrant(
          `scope ${dimension}, which liveScopes() does not declare`,
          'Grant only declared dimensions, and pass the declaration: liveEndpoint({ scopes }).',
        );
        continue;
      }
      if (granted === 'all') {
        keys.set(dimension, 'all');
        continue;
      }
      if (granted.length > MAX_GRANT_KEYS) {
        badGrant(
          `${granted.length} ${dimension} keys, over ${MAX_GRANT_KEYS}`,
          `Grant at most ${MAX_GRANT_KEYS} keys per dimension, or 'all'.`,
        );
      }
      const normalized = new Set<string>();
      for (const key of granted) {
        const written = normalizeKey(kind, key);
        if (written === undefined || !scopeKeySchema.safeParse(written).success) {
          badGrant(
            `${dimension} key ${JSON.stringify(key).slice(0, 80)}, which is not a ${kind} key`,
            'Grant keys of the dimension key kind (uuid, text up to 512 bytes, integer).',
          );
        } else {
          normalized.add(written);
        }
      }
      keys.set(dimension, [...normalized].toSorted());
    }
    return keys;
  }

  function viewFor(grant: LiveGrant): View {
    const granted = new Map<string, TableTag>();
    for (const tag of grant.tables ?? known.values()) {
      const table = known.get(tagKey(tag));
      if (table !== undefined) granted.set(tagKey(tag), table);
    }
    const keys = keysOf(grant.scopes);
    const visible = manifest.filter(entry =>
      entry.reads.every(read => {
        if (!granted.has(tagKey(read))) return false;
        const scoped = byTag.get(tagKey(read));
        if (scoped === undefined) return true;
        const own = keys.get(scoped.dimension);
        if (own === 'all') return true;
        return own !== undefined && own.length > 0 && entry.scope?.[scoped.dimension] !== undefined;
      }),
    );
    const scopes = [...granted].flatMap(([key, tag]) => {
      const scoped = byTag.get(key);
      const own = scoped === undefined ? undefined : keys.get(scoped.dimension);
      return scoped === undefined || own === undefined ? [] : [{ tag, name: scoped.dimension, keys: own }];
    });
    const view: LiveView = { tables: [...granted.values()], scopes };
    return {
      manifest: visible,
      hub: view,
      scopes:
        kinds.size === 0
          ? undefined
          : Object.fromEntries([...keys].map(([name, own]) => [name, own === 'all' ? own : [...own]])),
      fingerprint: JSON.stringify([visible.map(entry => entry.path), view]),
    };
  }

  /** The grant `authorize` gives `request` now, as a view; `undefined` when it refuses. */
  async function authorized(request: Request): Promise<View | undefined> {
    const grant = await options.authorize(request);
    return grant === null ? undefined : viewFor(grant);
  }

  /** Whether `request` is still granted exactly `view`. A refusal or a failing `authorize` is a change: the reconnect answers for it. */
  async function same(request: Request, view: View): Promise<boolean> {
    try {
      const now = await authorized(request);
      return now?.fingerprint === view.fingerprint;
    } catch (error) {
      debugHttp.warn('authorize() failed while re-checking a stream: {message}; sending bye', {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /** Attaches to the hub now (before the response exists) and ends the stream at `maxAgeMs` or when the request goes. */
  async function open(
    view: View,
    cursor: string | undefined,
    request: Request,
    signal: AbortSignal,
  ): Promise<AsyncIterable<LiveEvent>> {
    const detach = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      debugHttp.debug('a stream reached its max age of {maxAgeMs} ms; sending bye', { maxAgeMs });
      end();
    }, maxAgeMs);
    function end(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', end);
      detach.abort();
    }
    signal.addEventListener('abort', end, { once: true });
    if (signal.aborted) end();
    let feed: AsyncIterable<LiveFeed>;
    try {
      feed = await hub.open({
        ...(cursor === undefined ? {} : { cursor }),
        view: view.hub,
        signal: detach.signal,
      });
    } catch (error) {
      end();
      throw toHttpError(error);
    }
    debugHttp.debug('stream opened: {procedures} procedures, {tables} tables visible', {
      procedures: view.manifest.length,
      tables: view.hub.tables?.length ?? 0,
    });
    return framesFor(feed, view, {
      expired: () => expired,
      end,
      recheck: {
        needed: tags => reauthorize.size > 0 && tags.some(tag => reauthorize.has(tagKey(tag))),
        same: () => same(request, view),
      },
    });
  }

  const bundle = routes()
    .derive('liveView', async (request, ctx) => {
      checkCursor(ctx.url);
      const view = await authorized(request);
      if (view === undefined) {
        throw new HttpError(401, LIVE_ERROR_CODES.auth, 'the live stream refused this request', {
          remediation: 'Sign in again; the client stops reconnecting until its headers or session change.',
        });
      }
      return view;
    })
    // Attaching waits for the hub to open the cursor, so it runs here, before any header.
    .derive('liveFeed', (request, ctx) =>
      open(ctx.liveView, ctx.url.searchParams.get('cursor') ?? undefined, request, ctx.signal),
    )
    .bind(liveRoute, (_input, ctx) => ctx.liveFeed);

  return { contract: liveRoute, routes: bundle, fetch: buildEngine([bundle]).fetch };
}
