/**
 * The hub: turns source events (Postgres commits, in production) into numbered
 * `change` frames, keeps a bounded replay ring, and feeds every open stream.
 * Portable: no Postgres code here; `@arki/live/pg` is one source.
 *
 * The rules a client relies on:
 *
 * - An epoch is a random 12-character name. Every `ready` from the source
 *   starts a new one, so nothing resumes across a listener gap.
 * - `open()` attaches the stream and reads the ring's high-water mark in one
 *   synchronous step. Every later frame reaches it; every earlier one is in the
 *   replay or covered by a reset.
 * - A cursor of this epoch still in the ring resumes. Anything else (none,
 *   another epoch, evicted, from the future) resets.
 * - A stream whose queue passes `subscriberFrames` gets `bye`: it reconnects
 *   with its cursor instead of buffering without bound.
 * - `stop()` is final and settles once: every stream gets `bye`, the batch
 *   timer is cleared, and the promise resolves only after the source stopped
 *   (also when `start()` is still running). Every call returns that promise.
 */
import { z } from 'zod';

import type { LiveCursor, LiveEvent, TableTag } from './types.js';
import { debugHub } from './debug.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { tagKey } from './manifest.js';
import { replayRing } from './replay.js';
import { liveCursorSchema } from './schema.js';

/** What a source reports: the listener is ready (or back), the listener lost continuity, or tables changed at commit. */
export type LiveSourceEvent =
  | { readonly kind: 'ready' }
  | { readonly kind: 'gap' }
  | { readonly kind: 'change'; readonly tags: readonly TableTag[]; readonly txid?: string };

/** Where hints come from. `start` resolves with the function that stops it. */
export type LiveSource = { start(receive: (event: LiveSourceEvent) => void): Promise<() => Promise<void>> };

/** The hub's bounds. Every one is a positive integer; omitted ones take the default. */
export type LiveLimits = {
  /** Tags are unioned for this long, in ms (a fixed window, so a write storm still flushes). Default 20. */
  readonly batchMs?: number;
  /** Frames kept for resume. Default 4096. */
  readonly replayFrames?: number;
  /** Frames older than this many ms are evicted. Default 120 000. */
  readonly replayMs?: number;
  /** Over this many queued frames the stream gets `bye`. Default 256. */
  readonly subscriberFrames?: number;
};

const limitsSchema = z
  .object({
    /** Tags are unioned for this long (a fixed window, so a write storm still flushes). */
    batchMs: z.int().positive().default(20),
    /** Frames kept for resume. */
    replayFrames: z.int().positive().default(4096),
    /** Frames older than this are evicted. */
    replayMs: z.int().positive().default(120_000),
    /** Over this many queued frames the stream gets `bye`. */
    subscriberFrames: z.int().positive().default(256),
  })
  .strict() satisfies z.ZodType<Required<LiveLimits>, LiveLimits>;

/**
 * What one stream yields: `begin` once, then `change` frames, ending with `gap` or `bye` when the
 * hub ends it. A `change` carries, next to its wire fields, `txidsByTag`: for each of its `tags`
 * (same index) the transactions that wrote that table, so a filter that drops a tag drops the
 * txids only it explains. `txids` is their union.
 */
export type LiveFeed =
  | { readonly kind: 'begin'; readonly mode: 'resume' | 'reset'; readonly cursor: LiveCursor }
  | (Extract<LiveEvent, { kind: 'change' }> & { readonly txidsByTag: readonly (readonly string[])[] })
  | Extract<LiveEvent, { kind: 'gap' | 'bye' }>;

export type LiveHub = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): 'idle' | 'ready' | 'unavailable' | 'stopped';
  /** Attaches a stream now. Throws E003 unless the hub is `ready`, E004 for a malformed cursor. */
  open(options: { readonly cursor?: LiveCursor; readonly signal: AbortSignal }): AsyncIterable<LiveFeed>;
  connections(): number;
};

type ChangeFrame = Extract<LiveFeed, { kind: 'change' }>;
type EndFrame = Extract<LiveEvent, { kind: 'gap' | 'bye' }>;

type Subscriber = {
  /** `begin` and the replay, captured at attach. Not counted against `subscriberFrames`. */
  preamble: readonly LiveFeed[];
  preambleAt: number;
  /** Live frames not yet taken. */
  pending: ChangeFrame[];
  /** Delivered after everything queued before it; then the stream ends. */
  end: EndFrame | undefined;
  done: boolean;
  wake: (() => void) | undefined;
  unlisten: () => void;
};

const MAX_TAGS_PER_FRAME = 256;
/** A batch that reaches this many transactions flushes at once: no frame can name more. */
const MAX_TXIDS_PER_FRAME = 256;
const EPOCH = /^[a-z0-9]{12}$/;
const EPOCH_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Unique per hub start, not secret: a cursor grants nothing (every refetch is
 * authorized by its procedure), so `Math.random` is enough and runs on every
 * engine, Hermes included.
 */
function randomEpoch(): string {
  let epoch = '';
  for (let index = 0; index < 12; index += 1) {
    epoch += EPOCH_ALPHABET.charAt(Math.floor(Math.random() * EPOCH_ALPHABET.length));
  }
  return epoch;
}

function wake(subscriber: Subscriber): void {
  const resolve = subscriber.wake;
  subscriber.wake = undefined;
  resolve?.();
}

function take(subscriber: Subscriber): LiveFeed | undefined {
  const early = subscriber.preamble[subscriber.preambleAt];
  if (early) {
    subscriber.preambleAt += 1;
    return early;
  }
  const frame = subscriber.pending.shift();
  if (frame) return frame;
  const end = subscriber.end;
  if (end) {
    subscriber.end = undefined;
    subscriber.done = true;
  }
  return end;
}

export function createLiveHub(options: {
  readonly source: LiveSource;
  readonly limits?: LiveLimits;
  readonly epoch?: () => string;
}): LiveHub {
  const parsed = limitsSchema.safeParse(options.limits ?? {});
  if (!parsed.success) {
    throw liveError(
      LIVE_ERROR_CODES.config,
      `createLiveHub(): bad limits: ${parsed.error.message}`,
      'Every limit is a positive integer (milliseconds or frames).',
    );
  }
  const limits = parsed.data;
  const nextEpoch = options.epoch ?? randomEpoch;

  let state: 'idle' | 'ready' | 'unavailable' | 'stopped' = 'idle';
  /** The source's start, once `start()` was called. */
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stopSource: (() => Promise<void>) | undefined;
  let epoch = '';
  let seq = 0;
  const ring = replayRing<ChangeFrame>({ frames: limits.replayFrames, ms: limits.replayMs });
  /** The open batch: each table, with the transactions that wrote it. */
  const batch = new Map<string, { readonly tag: TableTag; readonly txids: Set<string> }>();
  /** Every transaction of the open batch, for the per-frame cap. */
  const batchTxIds = new Set<string>();
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<Subscriber>();

  const cursorAt = (at: number): LiveCursor => `${epoch}.${at}`;

  function clearBatch(): void {
    if (batchTimer !== undefined) clearTimeout(batchTimer);
    batchTimer = undefined;
    batch.clear();
    batchTxIds.clear();
  }

  /** The hub ends the stream: queued frames are dropped, `end` is the last thing it yields. Safe inside a loop over `subscribers` (a Set skips deleted entries). */
  function finish(subscriber: Subscriber, end: EndFrame): void {
    subscribers.delete(subscriber);
    subscriber.unlisten();
    subscriber.preamble = [];
    subscriber.pending = [];
    subscriber.end = end;
    wake(subscriber);
  }

  /** The consumer ended the stream (abort or `return()`): nothing more is yielded. */
  function close(subscriber: Subscriber): void {
    subscribers.delete(subscriber);
    subscriber.unlisten();
    subscriber.preamble = [];
    subscriber.pending = [];
    subscriber.end = undefined;
    subscriber.done = true;
    wake(subscriber);
  }

  function deliver(subscriber: Subscriber, frame: ChangeFrame): void {
    subscriber.pending.push(frame);
    if (subscriber.pending.length > limits.subscriberFrames) {
      debugHub.debug('{epoch}: a stream fell {frames} frames behind; sending bye', {
        epoch,
        frames: subscriber.pending.length,
      });
      finish(subscriber, { kind: 'bye' });
      return;
    }
    wake(subscriber);
  }

  function flush(): void {
    if (batchTimer !== undefined) clearTimeout(batchTimer);
    batchTimer = undefined;
    const tables = [...batch.values()];
    batch.clear();
    batchTxIds.clear();
    if (state !== 'ready' || tables.length === 0) return;
    const now = Date.now();
    for (let from = 0; from < tables.length; from += MAX_TAGS_PER_FRAME) {
      seq += 1;
      const part = tables.slice(from, from + MAX_TAGS_PER_FRAME);
      const txidsByTag = part.map(entry => [...entry.txids]);
      // Each frame names exactly the transactions that wrote its own tables.
      const frame: ChangeFrame = {
        kind: 'change',
        cursor: cursorAt(seq),
        tags: part.map(entry => entry.tag),
        txids: [...new Set(txidsByTag.flat())],
        txidsByTag,
      };
      ring.add(seq, now, frame);
      for (const subscriber of subscribers) deliver(subscriber, frame);
    }
    ring.evict(now);
    debugHub.debug('{epoch}: frame {seq} with {tables} tables to {streams} streams', {
      epoch,
      seq,
      tables: tables.length,
      streams: subscribers.size,
    });
  }

  function beginEpoch(): void {
    // A second `ready` without a `gap` still means the listener reconnected: continuity is unknown.
    for (const subscriber of subscribers) finish(subscriber, { kind: 'gap' });
    clearBatch();
    const next = nextEpoch();
    if (!EPOCH.test(next) || next === epoch) {
      state = 'unavailable';
      throw liveError(
        LIVE_ERROR_CODES.config,
        `createLiveHub(): epoch() returned ${JSON.stringify(next)}; it must be 12 characters [a-z0-9], new on every call`,
        'Omit `epoch` (the default is random), or return a fresh value each time: a repeated epoch would resume across a gap.',
      );
    }
    epoch = next;
    seq = 0;
    ring.clear();
    state = 'ready';
    debugHub.debug('{epoch}: ready', { epoch });
  }

  function receive(event: LiveSourceEvent): void {
    if (state === 'stopped') return;
    switch (event.kind) {
      case 'ready': {
        beginEpoch();
        return;
      }
      case 'gap': {
        state = 'unavailable';
        clearBatch();
        for (const subscriber of subscribers) finish(subscriber, { kind: 'gap' });
        debugHub.debug('{epoch}: listener gap; streams ended', { epoch });
        return;
      }
      case 'change': {
        if (state !== 'ready') return;
        for (const tag of event.tags) {
          const key = tagKey(tag);
          const entry = batch.get(key) ?? { tag, txids: new Set<string>() };
          if (event.txid !== undefined) entry.txids.add(event.txid);
          batch.set(key, entry);
        }
        if (event.txid !== undefined) batchTxIds.add(event.txid);
        if (batchTxIds.size >= MAX_TXIDS_PER_FRAME) flush();
        else batchTimer ??= setTimeout(flush, limits.batchMs);
        return;
      }
    }
  }

  /** The frames to replay after `cursor`, or `undefined` for a reset. */
  function replayAfter(cursor: LiveCursor): readonly ChangeFrame[] | undefined {
    const dot = cursor.indexOf('.');
    if (cursor.slice(0, dot) !== epoch) return undefined;
    return ring.after(Number(cursor.slice(dot + 1)), seq);
  }

  /** Ends every stream, then stops the source once its start settled. Runs once. */
  async function shutdown(): Promise<void> {
    state = 'stopped';
    clearBatch();
    for (const subscriber of subscribers) finish(subscriber, { kind: 'bye' });
    debugHub.debug('{epoch}: stopping', { epoch });
    try {
      await starting;
    } catch {
      // A failed start rejected to its own caller and left nothing to stop.
    }
    const stop = stopSource;
    stopSource = undefined;
    await stop?.();
    debugHub.debug('{epoch}: stopped', { epoch });
  }

  async function* feed(subscriber: Subscriber): AsyncGenerator<LiveFeed, void, undefined> {
    try {
      for (;;) {
        const item = take(subscriber);
        if (item) {
          yield item;
          continue;
        }
        if (subscriber.done) return;
        await new Promise<void>(resolve => {
          subscriber.wake = resolve;
        });
      }
    } finally {
      close(subscriber);
    }
  }

  return {
    start() {
      if (starting !== undefined || stopping !== undefined) {
        return Promise.reject(
          liveError(
            LIVE_ERROR_CODES.config,
            `LiveHub.start() on a hub that was ${stopping === undefined ? 'already started' : 'stopped'}`,
            'Start a hub once; make a new hub after stop().',
          ),
        );
      }
      // `stop()` waits for this, then stops the source it resolved with.
      starting = options.source.start(receive).then(stop => {
        stopSource = stop;
      });
      return starting;
    },

    stop() {
      stopping ??= shutdown();
      return stopping;
    },

    status: () => state,

    open({ cursor, signal }) {
      if (state !== 'ready') {
        throw liveError(
          LIVE_ERROR_CODES.source,
          `the live hub is ${state}, not ready`,
          'Retry with backoff: the hub is ready again once its Postgres listener is back.',
        );
      }
      if (cursor !== undefined && !liveCursorSchema.safeParse(cursor).success) {
        throw liveError(
          LIVE_ERROR_CODES.protocol,
          `malformed cursor ${JSON.stringify(cursor)}`,
          'Send back a cursor exactly as a frame gave it, or none.',
        );
      }
      // Attach and read the high-water mark in one synchronous step: no frame can fall between them.
      ring.evict(Date.now());
      const replay = cursor === undefined ? undefined : replayAfter(cursor);
      const preamble: readonly LiveFeed[] =
        cursor === undefined || replay === undefined
          ? [{ kind: 'begin', mode: 'reset', cursor: cursorAt(seq) }]
          : [{ kind: 'begin', mode: 'resume', cursor }, ...replay];
      const onAbort = (): void => close(subscriber);
      const subscriber: Subscriber = {
        preamble,
        preambleAt: 0,
        pending: [],
        end: undefined,
        done: false,
        wake: undefined,
        unlisten: () => signal.removeEventListener('abort', onAbort),
      };
      subscribers.add(subscriber);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) close(subscriber);
      debugHub.debug('{epoch}: stream opened ({mode}, {replay} frames to replay)', {
        epoch,
        mode: replay === undefined ? 'reset' : 'resume',
        replay: preamble.length - 1,
      });
      return feed(subscriber);
    },

    connections: () => subscribers.size,
  };
}
