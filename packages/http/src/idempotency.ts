/**
 * Idempotency keys for HTTP: `idempotent(...)` is an `HttpMiddleware` that runs a request once per
 * key and answers a repeat with the stored response.
 *
 * Portable: no Node-only API. It hashes with Web Crypto. The stores live elsewhere:
 * `@arki/journal/http` (Postgres) and `@arki/kv/redis/idempotency` (Redis) implement
 * {@link ResponseCache}. This is a response cache for HTTP replay. It is not the journal's
 * command receipt, which commits with the business write.
 */
import { z } from 'zod';

import type { HttpMiddleware } from './engine.js';
import { fromBase64, readCapped, toBase64, toHex } from './bytes.js';
import { HTTP_ERROR_CODES, HttpError } from './error.js';

/** A response as the cache keeps it: the status, the allowlisted headers, and the body as base64. */
export const storedResponse = z.object({
  status: z.int().min(200).max(599),
  headers: z.record(z.string(), z.string()),
  body: z.string(),
});
export type StoredResponse = z.infer<typeof storedResponse>;

/** What `begin` found for a key. */
export type BeginResult =
  /** This request owns the key and must call `finish` or `abandon`. */
  | 'started'
  /** A finished request holds the key with the same fingerprint. Answer with `replay`. */
  | { readonly replay: StoredResponse }
  /** Another request holds the key and has not finished. */
  | 'in-progress'
  /** The key is held by a request with a different fingerprint. */
  | 'conflict';

/**
 * Where responses wait for a repeat. Every method is atomic in the store. `owner` is a token
 * that is unique per request: only the owner can `finish` or `abandon`, so a slow worker whose
 * entry expired and was given to someone else cannot overwrite the new entry.
 * `ttl` is in milliseconds and counts from `begin`. An expired entry can be taken again.
 */
export type ResponseCache = {
  begin(key: string, fingerprint: string, owner: string, ttl: number): Promise<BeginResult>;
  /** Store the response under the key. A no-op when `owner` does not hold the key any more. */
  finish(key: string, owner: string, response: StoredResponse): Promise<void>;
  /** Free the key so a retry can run again. A no-op when `owner` does not hold the key. */
  abandon(key: string, owner: string): Promise<void>;
};

export type IdempotentOptions = {
  readonly cache: ResponseCache;
  /**
   * Who is asking: a user id, a tenant plus user, an API key id. Runs for each listed request.
   * Return `undefined` for an unauthenticated request: it skips the cache entirely, so it never
   * replays, and the handler's own authentication answers it. The key is scoped by this value,
   * so two callers can use the same key without meeting.
   */
  readonly scope: (req: Request) => string | undefined | Promise<string | undefined>;
  /** Routes that need a key, as `'METHOD /path'`. `:name` matches one segment, `:name?` one optional trailing segment. Include any mount prefix. */
  readonly routes: readonly string[];
  /** Default `Idempotency-Key`. */
  readonly header?: string;
  /** How long a key lives, in milliseconds. */
  readonly ttl: number;
  /** Default 1 MiB. A request body over this runs uncached. A response body over this is not stored. */
  readonly maxBodyBytes?: number;
  /** Response headers a replay carries, lower case. Default `content-type`, `location`, `etag`. */
  readonly replayHeaders?: readonly string[];
};

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const DEFAULT_REPLAY_HEADERS = ['content-type', 'location', 'etag'] as const;
const MAX_KEY_LENGTH = 255;
const textEncoder = new TextEncoder();

const sha256 = async (data: Uint8Array<ArrayBuffer> | string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? textEncoder.encode(data) : data));

type RoutePattern = { readonly method: string; readonly path: RegExp };

/** `'POST /orders/:id'` to a method and an anchored path pattern. */
const compileRoute = (route: string): RoutePattern => {
  const space = route.indexOf(' ');
  if (space < 1) throw new TypeError(`idempotent: route ${JSON.stringify(route)} must look like "POST /path"`);
  const path = route
    .slice(space + 1)
    .trim()
    .split('/')
    .map(segment => {
      if (segment.startsWith(':')) return segment.endsWith('?') ? '(?:/[^/]+)?' : '/[^/]+';
      return segment === '' ? '' : `/${segment.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)}`;
    })
    .join('');
  return { method: route.slice(0, space).toUpperCase(), path: new RegExp(`^${path === '' ? '/' : path}/?$`) };
};

/** Method + path + sorted query + body hash, hashed. Two requests share a fingerprint only when they ask for the same thing. */
const fingerprintOf = async (req: Request, url: URL, body: Uint8Array<ArrayBuffer>): Promise<string> => {
  const query = [...url.searchParams].toSorted(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  return sha256(`${req.method}\n${url.pathname}\n${JSON.stringify(query)}\n${await sha256(body)}`);
};

const replayResponse = (stored: StoredResponse): Response => {
  const headers = new Headers(stored.headers);
  headers.set('idempotent-replayed', 'true');
  const bodyless = stored.status === 204 || stored.status === 205 || stored.status === 304;
  return new Response(bodyless ? null : fromBase64(stored.body), { status: stored.status, headers });
};

/** 5xx and the two retry-me statuses are not an answer worth repeating. */
const isCacheable = (status: number): boolean => status < 500 && status !== 409 && status !== 429;

/**
 * Run each listed request once per `Idempotency-Key`. Put it after authentication and CORS in the
 * `middleware` list, so the principal in `scope` is already trusted.
 *
 * What is stored: every 2xx, 3xx and 4xx answer except 409 and 429, because a client that gets
 * those is expected to try again. A 5xx, a 409, a 429, a thrown handler, a streaming response
 * (`text/event-stream`) and a response body over `maxBodyBytes` call `abandon`: the key is freed
 * and a retry runs the handler again. A request body over `maxBodyBytes` cannot be fingerprinted
 * cheaply, so it runs without protection.
 *
 * A missing or unusable key on a listed route is 400. The same key with another request is 422.
 * The same key while the first is running is 409 with `retry-after`. If the cache itself fails,
 * the request fails: running it unprotected could do the work twice.
 */
export function idempotent(options: IdempotentOptions): HttpMiddleware {
  const { cache, scope, ttl } = options;
  const headerName = options.header ?? 'Idempotency-Key';
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const allowed = new Set((options.replayHeaders ?? DEFAULT_REPLAY_HEADERS).map(name => name.toLowerCase()));
  const patterns = options.routes.map(route => compileRoute(route));

  return async (req, next) => {
    const url = new URL(req.url);
    if (!patterns.some(pattern => pattern.method === req.method && pattern.path.test(url.pathname))) return next(req);

    const principal = await scope(req);
    if (principal === undefined) return next(req);

    const supplied = req.headers.get(headerName)?.trim();
    if (supplied === undefined || supplied === '' || supplied.length > MAX_KEY_LENGTH)
      throw new HttpError(
        400,
        HTTP_ERROR_CODES.idempotencyKeyMissing,
        `${headerName} is required on ${req.method} ${url.pathname} and must be 1 to ${MAX_KEY_LENGTH} characters`,
        {
          remediation: `Send a unique ${headerName} header, for example a UUID, and repeat it only to retry the same request.`,
        },
      );

    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > maxBodyBytes) return next(req);
    const body = await readCapped(req.clone().body, maxBodyBytes);
    if (body === undefined) return next(req);

    const key = await sha256(`${principal.length}:${principal}${supplied}`);
    const fingerprint = await fingerprintOf(req, url, body);
    const owner = crypto.randomUUID();

    const outcome = await cache.begin(key, fingerprint, owner, ttl);
    if (outcome === 'conflict')
      throw new HttpError(
        422,
        HTTP_ERROR_CODES.idempotencyKeyReused,
        `${headerName} was already used for a different request`,
        {
          remediation:
            'Use a new key for a different request. Repeat a key only with the same method, path, query and body.',
        },
      );
    if (outcome === 'in-progress')
      throw new HttpError(409, HTTP_ERROR_CODES.idempotencyInProgress, 'A request with this key is still running', {
        headers: { 'retry-after': '1' },
        remediation: 'Wait and send the same request again.',
      });
    if (outcome !== 'started') return replayResponse(outcome.replay);

    let response: Response;
    try {
      response = await next(req);
    } catch (error) {
      await cache.abandon(key, owner);
      throw error;
    }

    const streaming = response.headers.get('content-type')?.startsWith('text/event-stream') === true;
    if (streaming || !isCacheable(response.status)) {
      await cache.abandon(key, owner);
      return response;
    }
    const bytes = await readCapped(response.clone().body, maxBodyBytes);
    if (bytes === undefined) {
      await cache.abandon(key, owner);
      return response;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of response.headers) if (allowed.has(name)) headers[name] = value;
    try {
      await cache.finish(key, owner, { status: response.status, headers, body: toBase64(bytes) });
    } catch (error) {
      // The work is done but its answer is not stored. Free the key if the cache still answers, and fail loud.
      await cache.abandon(key, owner).catch(() => {
        /* the original error is the one to report */
      });
      throw error;
    }
    return response;
  };
}
