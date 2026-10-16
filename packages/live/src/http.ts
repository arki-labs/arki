/**
 * `@arki/live/http` (peer `@arki/http`): the SSE stream, `GET /api/live`.
 *
 * What a request goes through, in this order, all before any stream header:
 *
 * 1. The `cursor` query parameter: absent, or exactly one well-formed cursor
 *    (else 400 E004).
 * 2. `authorize(request)`: `null` answers 401 E005.
 * 3. The grant picks what this client may see: the manifest entries whose
 *    every table it may read, and the tables whose hints it gets.
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
 * so the client reconnects and is authorized again.
 */
import { z } from 'zod';

import type { RouteBundle, SseContract } from '@arki/http';
import { buildEngine, HttpError, optional, route, routes } from '@arki/http';

import type { LiveFeed, LiveGrant, LiveHub } from './hub.js';
import type { LiveEvent, LiveManifest, TableTag } from './types.js';
import { debugHttp } from './debug.js';
import { isLiveError, LIVE_ERROR_CODES, liveError } from './errors.js';
import { tagKey } from './manifest.js';
import { liveCursorSchema, liveEventSchema } from './schema.js';

/** What `authorize` grants a client. `tables` omitted: every table of the manifest. */
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

/** What one client may see: its part of the manifest and the tables whose hints reach it. */
type View = { readonly manifest: LiveManifest; readonly tables: readonly TableTag[] };

function viewOf(manifest: LiveManifest, tables: ReadonlyMap<string, TableTag>): View {
  return {
    manifest: manifest.filter(entry => entry.reads.every(read => tables.has(tagKey(read)))),
    tables: [...tables.values()],
  };
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
  expired: () => boolean,
  end: () => void,
): AsyncGenerator<LiveEvent, void, undefined> {
  try {
    for await (const item of feed) {
      switch (item.kind) {
        case 'begin': {
          yield { kind: 'hello', v: 1, mode: item.mode, cursor: item.cursor, manifest: view.manifest };
          break;
        }
        case 'change': {
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
 * `manifest` is the app's (`liveManifest(contract)`); `authorize` sees the
 * request before any header is sent.
 */
export function liveEndpoint(options: {
  readonly hub: LiveHub;
  readonly manifest: LiveManifest;
  readonly authorize: (request: Request) => Promise<LiveGrant | null>;
  readonly maxAgeMs?: number;
}): LiveEndpoint {
  const parsed = optionsSchema.safeParse({ maxAgeMs: options.maxAgeMs });
  if (!parsed.success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `liveEndpoint(): bad maxAgeMs: ${parsed.error.message}`,
      'maxAgeMs is a positive integer of milliseconds (default 300 000).',
    );
  }
  const { maxAgeMs } = parsed.data;
  const { hub, manifest } = options;
  const manifestTables = new Map(manifest.flatMap(entry => entry.reads.map(read => [tagKey(read), read] as const)));
  const everything = viewOf(manifest, manifestTables);

  function viewFor(grant: LiveGrant): View {
    if (grant.tables === undefined) return everything;
    const granted = new Map<string, TableTag>();
    for (const tag of grant.tables) {
      const known = manifestTables.get(tagKey(tag));
      if (known !== undefined) granted.set(tagKey(tag), known);
    }
    return viewOf(manifest, granted);
  }

  /** Attaches to the hub now (before the response exists) and ends the stream at `maxAgeMs` or when the request goes. */
  async function open(view: View, cursor: string | undefined, request: AbortSignal): Promise<AsyncIterable<LiveEvent>> {
    const detach = new AbortController();
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      debugHttp.debug('a stream reached its max age of {maxAgeMs} ms; sending bye', { maxAgeMs });
      end();
    }, maxAgeMs);
    function end(): void {
      clearTimeout(timer);
      request.removeEventListener('abort', end);
      detach.abort();
    }
    request.addEventListener('abort', end, { once: true });
    if (request.aborted) end();
    let feed: AsyncIterable<LiveFeed>;
    try {
      feed = await hub.open({
        ...(cursor === undefined ? {} : { cursor }),
        grant: { tables: view.tables },
        signal: detach.signal,
      });
    } catch (error) {
      end();
      throw toHttpError(error);
    }
    debugHttp.debug('stream opened: {procedures} procedures, {tables} tables visible', {
      procedures: view.manifest.length,
      tables: view.tables.length,
    });
    return framesFor(feed, view, () => expired, end);
  }

  const bundle = routes()
    .derive('liveView', async (request, ctx) => {
      checkCursor(ctx.url);
      const grant = await options.authorize(request);
      if (grant === null) {
        throw new HttpError(401, LIVE_ERROR_CODES.auth, 'the live stream refused this request', {
          remediation: 'Sign in again; the client stops reconnecting until its headers or session change.',
        });
      }
      return viewFor(grant);
    })
    // Attaching waits for the hub to open the cursor, so it runs here, before any header.
    .derive('liveFeed', (_request, ctx) =>
      open(ctx.liveView, ctx.url.searchParams.get('cursor') ?? undefined, ctx.signal),
    )
    .bind(liveRoute, (_input, ctx) => ctx.liveFeed);

  return { contract: liveRoute, routes: bundle, fetch: buildEngine([bundle]).fetch };
}
