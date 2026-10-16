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
 */
import { z } from 'zod';

import type { LiveCursor, LiveEvent, TableTag } from './schema.js';
import { debugHub } from './debug.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { tagKey } from './manifest.js';
import { liveCursorSchema } from './schema.js';

/** What a source reports: the listener is ready (or back), the listener lost continuity, or tables changed at commit. */
export type LiveSourceEvent =
  | { readonly kind: 'ready' }
  | { readonly kind: 'gap' }
  | { readonly kind: 'change'; readonly tags: readonly TableTag[] };

/** Where hints come from. `start` resolves with the function that stops it. */
export type LiveSource = { start(receive: (event: LiveSourceEvent) => void): Promise<() => Promise<void>> };

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
  .strict();

export type LiveLimits = Readonly<z.input<typeof limitsSchema>>;

/** What one stream yields: `begin` once, then `change` frames, ending with `gap` or `bye` when the hub ends it. */
export type LiveFeed =
  | { readonly kind: 'begin'; readonly mode: 'resume' | 'reset'; readonly cursor: LiveCursor }
  | Extract<LiveEvent, { kind: 'change' | 'gap' | 'bye' }>;

export type LiveHub = {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): 'idle' | 'ready' | 'unavailable' | 'stopped';
  /** Attaches a stream now. Throws E003 unless the hub is `ready`, E004 for a malformed cursor. */
  open(options: { readonly cursor?: LiveCursor; readonly signal: AbortSignal }): AsyncIterable<LiveFeed>;
  connections(): number;
};

type ChangeFrame = Extract<LiveEvent, { kind: 'change' }>;
type EndFrame = Extract<LiveEvent, { kind: 'gap' | 'bye' }>;
type RingEntry = { readonly seq: number; readonly at: number; readonly frame: ChangeFrame };

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
  let started = false;
  let stopSource: (() => Promise<void>) | undefined;
  let epoch = '';
  let seq = 0;
  /** The highest sequence no longer in the ring: a cursor below it cannot resume. */
  let evictedThrough = 0;
  const ring: RingEntry[] = [];
  const batch = new Map<string, TableTag>();
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<Subscriber>();

  const cursorAt = (at: number): LiveCursor => `${epoch}.${at}`;

  function clearBatch(): void {
    if (batchTimer !== undefined) clearTimeout(batchTimer);
    batchTimer = undefined;
    batch.clear();
  }

  function evict(now: number): void {
    for (let oldest = ring[0]; oldest; oldest = ring[0]) {
      if (ring.length <= limits.replayFrames && now - oldest.at <= limits.replayMs) return;
      ring.shift();
      evictedThrough = oldest.seq;
    }
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
    batchTimer = undefined;
    const tags = [...batch.values()];
    batch.clear();
    if (state !== 'ready' || tags.length === 0) return;
    const now = Date.now();
    for (let from = 0; from < tags.length; from += MAX_TAGS_PER_FRAME) {
      seq += 1;
      const frame: ChangeFrame = {
        kind: 'change',
        cursor: cursorAt(seq),
        tags: tags.slice(from, from + MAX_TAGS_PER_FRAME),
      };
      ring.push({ seq, at: now, frame });
      for (const subscriber of subscribers) deliver(subscriber, frame);
    }
    evict(now);
    debugHub.debug('{epoch}: frame {seq} with {tables} tables to {streams} streams', {
      epoch,
      seq,
      tables: tags.length,
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
    evictedThrough = 0;
    ring.length = 0;
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
        for (const tag of event.tags) batch.set(tagKey(tag), tag);
        batchTimer ??= setTimeout(flush, limits.batchMs);
        return;
      }
    }
  }

  /** The sequence to resume after, or `undefined` for a reset. */
  function resumeAfter(cursor: LiveCursor): number | undefined {
    const dot = cursor.indexOf('.');
    if (cursor.slice(0, dot) !== epoch) return undefined;
    const at = Number(cursor.slice(dot + 1));
    return at >= evictedThrough && at <= seq ? at : undefined;
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
    async start() {
      if (started) {
        throw liveError(
          LIVE_ERROR_CODES.config,
          'LiveHub.start() was called twice',
          'Start a hub once; make a new hub after stop().',
        );
      }
      started = true;
      const stop = await options.source.start(receive);
      if (state === 'stopped') {
        await stop();
        return;
      }
      stopSource = stop;
    },

    async stop() {
      if (state === 'stopped') return;
      state = 'stopped';
      clearBatch();
      for (const subscriber of subscribers) finish(subscriber, { kind: 'bye' });
      const stop = stopSource;
      stopSource = undefined;
      debugHub.debug('{epoch}: stopped', { epoch });
      await stop?.();
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
      evict(Date.now());
      const after = cursor === undefined ? undefined : resumeAfter(cursor);
      const preamble: readonly LiveFeed[] =
        cursor === undefined || after === undefined
          ? [{ kind: 'begin', mode: 'reset', cursor: cursorAt(seq) }]
          : [
              { kind: 'begin', mode: 'resume', cursor },
              ...ring.filter(entry => entry.seq > after).map(entry => entry.frame),
            ];
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
        mode: after === undefined ? 'reset' : 'resume',
        replay: preamble.length - 1,
      });
      return feed(subscriber);
    },

    connections: () => subscribers.size,
  };
}
