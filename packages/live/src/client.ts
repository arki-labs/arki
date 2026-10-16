/**
 * The client half of the live stream, portable (browser, React Native/Hermes,
 * Node, Bun, Deno): `fetch` with a streaming body, read through a streaming
 * `TextDecoder`, framed by hand. No `EventSource` (it cannot send headers) and
 * no `TextDecoderStream` (missing on Hermes).
 *
 * One connection at a time, and what ends it decides the next one:
 *
 * - `hello` → status `live`; the retry count starts over.
 * - `bye` (the server closes on purpose: max age, stop, a slow client) →
 *   reconnect at once with the cursor, so the hub can resume.
 * - `gap` (the server lost its Postgres listener), a dropped connection, a 5xx
 *   or an `event: error` frame → `reconnecting`, back off (250 ms doubling to
 *   10 s, jittered), then reconnect with the cursor. A 503 waits at least its
 *   `retry-after`.
 * - 401/403 → `unauthorized`, and it stops: retrying would only be refused
 *   again. A new client (new headers, a remount) tries again.
 * - 400 (a cursor the server calls malformed) → drop the cursor and reconnect.
 *
 * `:keepalive` comments are skipped. The cursor is saved only after
 * `onEvent` settles, so a frame the app has not handled is resent on resume.
 * `online` and a page becoming visible end a backoff wait at once.
 */
import { backoff } from '@arki/resilience';

import type { LiveCursor, LiveEvent } from './types.js';
import { debugClient } from './debug.js';
import { isLiveError, LIVE_ERROR_CODES, liveError } from './errors.js';
import { parseLiveEvent } from './parse.js';

/** Where the stream is: first connect, open, between connects, refused (401/403), or stopped. */
export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'unauthorized' | 'closed';

export type LiveClient = {
  /** Opens the stream. Once per client; a stopped client stays stopped. */
  start(): void;
  /** Closes the stream for good: status `closed`. */
  stop(): void;
  status(): LiveStatus;
};

export type LiveClientOptions = {
  readonly url: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  /** Read before every connect, so a refreshed token is used on the next one. */
  readonly headers?: () => HeadersInit | Promise<HeadersInit>;
  readonly credentials?: RequestCredentials;
  /** Resume from here on the first connect (a cursor a server-rendered page dehydrated). */
  readonly cursor?: LiveCursor;
  /** Every frame, in order. The next frame waits for the promise; the cursor is saved after it settles. */
  readonly onEvent: (event: LiveEvent) => void | Promise<void>;
  readonly onStatus?: (status: LiveStatus) => void;
};

/** 250 ms, doubling to 10 s, each wait 75–125% of that so many clients do not return at once. */
const RECONNECT = backoff.exponential({ base: 250, max: 10_000, jitter: 0.25 });
/** A `retry-after` longer than this is cut to it. */
const MAX_RETRY_AFTER_MS = 300_000;

type SseMessage = { readonly event: string; readonly data: string };

/**
 * The messages of an SSE body. Lines end at `\n`, `\r\n` or `\r`; a `\r` at the
 * end of a chunk waits for the next one, in case it is half of `\r\n`.
 * Comments (`:keepalive`) and unknown fields are skipped.
 */
async function* sseMessages(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let start = 0;
      for (let index = 0; index < buffer.length; index += 1) {
        const char = buffer[index];
        if (char !== '\n' && char !== '\r') continue;
        if (char === '\r' && index === buffer.length - 1 && !chunk.done) break;
        const line = buffer.slice(start, index);
        if (char === '\r' && buffer[index + 1] === '\n') index += 1;
        start = index + 1;
        if (line === '') {
          if (data.length > 0) yield { event: event === '' ? 'message' : event, data: data.join('\n') };
          event = '';
          data = [];
        } else {
          // A comment (`:keepalive`) has an empty field name, so it is skipped like any unknown field.
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const raw = colon === -1 ? '' : line.slice(colon + 1);
          const value = raw.startsWith(' ') ? raw.slice(1) : raw;
          if (field === 'data') data.push(value);
          else if (field === 'event') event = value;
        }
      }
      buffer = buffer.slice(start);
      if (chunk.done) return;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Already closed or errored: nothing left to release.
    }
  }
}

/** `retry-after` in milliseconds (seconds or an HTTP date), capped; `undefined` when absent or unreadable. */
function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (value === null) return undefined;
  const seconds = Number(value);
  const ms = value.trim() !== '' && Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isNaN(ms) ? undefined : Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function withCursor(url: string | URL, cursor: LiveCursor | undefined): string | URL {
  if (cursor === undefined) return url;
  if (typeof url !== 'string') {
    const next = new URL(url);
    next.searchParams.set('cursor', cursor);
    return next;
  }
  return `${url}${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}`;
}

/** How a connection ended: reconnect now, after a backoff (at least `minMs`), or stop. */
type Outcome =
  | { readonly next: 'now' }
  | { readonly next: 'backoff'; readonly reason: unknown; readonly minMs?: number }
  | { readonly next: 'stop' };

/** Calls `wake` when the network comes back or the page becomes visible; returns the unsubscribe. Browser only. */
function onNetworkBack(wake: () => void): () => void {
  if (!('addEventListener' in globalThis)) return (): void => undefined;
  const visible = (): void => {
    if (!('document' in globalThis) || document.visibilityState === 'visible') wake();
  };
  globalThis.addEventListener('online', wake);
  globalThis.addEventListener('visibilitychange', visible);
  return () => {
    globalThis.removeEventListener('online', wake);
    globalThis.removeEventListener('visibilitychange', visible);
  };
}

export function createLiveClient(options: LiveClientOptions): LiveClient {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const abort = new AbortController();
  /** A call, not a property read, so no narrowing survives the awaits between checks. */
  const stopped = (): boolean => abort.signal.aborted;
  let status: LiveStatus = 'connecting';
  let cursor = options.cursor;
  let started = false;
  /** Failed connects since the last `hello`. */
  let attempt = 0;
  /** Ends the current backoff wait early. */
  let wakeUp: (() => void) | undefined;

  function setStatus(next: LiveStatus): void {
    if (status === next || status === 'closed') return;
    status = next;
    options.onStatus?.(next);
  }

  async function connect(): Promise<Outcome> {
    const headers = new Headers(await options.headers?.());
    headers.set('accept', 'text/event-stream');
    const response = await fetcher(withCursor(options.url, cursor), {
      headers,
      signal: abort.signal,
      cache: 'no-store',
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      debugClient.warn('[{code}] the live stream refused this client ({status}); it stops until its headers change', {
        code: LIVE_ERROR_CODES.auth,
        status: response.status,
      });
      setStatus('unauthorized');
      return { next: 'stop' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 400) cursor = undefined;
      const minMs = response.status === 503 ? retryAfterMs(response) : undefined;
      return {
        next: 'backoff',
        reason: new Error(`live stream answered ${response.status}`),
        ...(minMs === undefined ? {} : { minMs }),
      };
    }
    if (!response.body) {
      throw liveError(
        LIVE_ERROR_CODES.protocol,
        'fetch() gave the live stream no streaming body',
        'Use a fetch with streaming responses (React Native: `expo/fetch`), and pass it as `fetch`.',
      );
    }
    for await (const message of sseMessages(response.body)) {
      if (message.event === 'error') {
        return { next: 'backoff', reason: new Error(`live stream error frame: ${message.data}`) };
      }
      let json: unknown;
      try {
        json = JSON.parse(message.data);
      } catch {
        json = undefined;
      }
      const event = parseLiveEvent(json);
      if (event === undefined) {
        debugClient.warn('[{code}] not a live frame: {data}', { code: LIVE_ERROR_CODES.protocol, data: message.data });
        return { next: 'backoff', reason: new Error('malformed live frame') };
      }
      if (event.kind === 'hello') {
        setStatus('live');
        attempt = 0;
      }
      await options.onEvent(event);
      if (event.kind === 'hello' || event.kind === 'change') cursor = event.cursor;
      if (event.kind === 'bye') return { next: 'now' };
      if (event.kind === 'gap') return { next: 'backoff', reason: new Error('the server lost its listener') };
    }
    return { next: 'backoff', reason: new Error('the live stream ended') };
  }

  function pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const done = (): void => {
        clearTimeout(timer);
        abort.signal.removeEventListener('abort', done);
        wakeUp = undefined;
        resolve();
      };
      const timer = setTimeout(done, ms);
      wakeUp = done;
      abort.signal.addEventListener('abort', done, { once: true });
    });
  }

  async function run(): Promise<void> {
    const unsubscribe = onNetworkBack(() => wakeUp?.());
    try {
      while (!stopped()) {
        let outcome: Outcome;
        try {
          outcome = await connect();
        } catch (error) {
          if (stopped()) return;
          // No streaming body: retrying cannot help, so stop and say why.
          if (isLiveError(error, LIVE_ERROR_CODES.protocol)) {
            debugClient.error('{message}', { message: error.message });
            setStatus('closed');
            return;
          }
          outcome = { next: 'backoff', reason: error };
        }
        if (outcome.next === 'stop' || stopped()) return;
        setStatus('reconnecting');
        if (outcome.next === 'now') continue;
        attempt += 1;
        const wait = Math.max(RECONNECT.delay(attempt, outcome.reason) ?? 10_000, outcome.minMs ?? 0);
        debugClient.debug('reconnecting in {wait} ms (attempt {attempt})', { wait, attempt });
        await pause(wait);
      }
    } finally {
      unsubscribe();
    }
  }

  return {
    start() {
      if (started) return;
      started = true;
      options.onStatus?.(status);
      void run();
    },
    stop() {
      abort.abort();
      setStatus('closed');
    },
    status: () => status,
  };
}
