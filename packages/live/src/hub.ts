/**
 * The hub: turns source events (Postgres commits, in production) into numbered
 * `change` frames, keeps a bounded replay ring, and feeds every open stream.
 * Portable: no Postgres code here; `@arki/live/pg` is one source.
 *
 * The rules a client relies on:
 *
 * - An epoch is a random 12-character name. Every `ready` from the source
 *   starts a new one, so nothing resumes across a listener gap.
 * - Cursors are opaque: `(epoch, seq)` sealed with AES-GCM under a key made
 *   at `start()`, fresh IV every time (`cursor.ts`). A client cannot count
 *   the frames its grant hides from it. A cursor this hub cannot open is
 *   unknown and resets.
 * - A `change` frame is sealed once, the first time a stream needs it, and
 *   every stream that gets the frame gets that same cursor. Sealing per
 *   stream would cost one AES-GCM call per client per frame; this costs one
 *   per frame. It leaks nothing: a client sees one frame's cursor whichever
 *   stream it came on, and still cannot read the frame number. `begin`
 *   cursors and `cursor()` are sealed fresh each time.
 * - `open()` opens the cursor, then attaches the stream and reads the ring's
 *   high-water mark in one synchronous step. Every later frame reaches it; every earlier one is in the
 *   replay or covered by a reset.
 * - Resume or reset depends on the cursor's age alone: a cursor of this
 *   epoch taken at most `replayMs` ago resumes, an older one resets. The ring
 *   evicts by that same age, so every frame a young cursor needs is kept.
 *   Anything else (none, another epoch, from the future) resets. Never by
 *   count: frames of hidden tables count too, so a client could learn from a
 *   reset that many of them happened.
 * - `replayFrames` is a hard cap, not an eviction: a ring that reaches it
 *   means the hub is overloaded. It starts a new epoch and ends every stream
 *   with `gap`, so every client resets together; that reveals only "the hub
 *   was overloaded", the same to everyone. Logged at warn.
 * - A stream whose queue passes `subscriberFrames` gets `bye`: it reconnects
 *   with its cursor instead of buffering without bound.
 * - `stop()` is final and settles once: every stream gets `bye`, the batch
 *   timer is cleared, and the promise resolves only after the source stopped
 *   (also when `start()` is still running). Every call returns that promise.
 */
import { z } from 'zod';

import type { CursorCipher, CursorPosition } from './cursor.js';
import type { LiveCursor, LiveEvent, TableTag } from './types.js';
import { cursorCipher } from './cursor.js';
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
  /**
   * The most frames the replay ring may hold. Reaching it is an overload: a new epoch starts and
   * every client resets together. Size it above `replayMs` × the peak frame rate (at most
   * 1000 / `batchMs` + commits per second / 256, per 256 tables in a window). Default 65 536.
   */
  readonly replayFrames?: number;
  /** A cursor taken this many ms ago still resumes; older ones reset, and frames older than this are evicted. Default 120 000. */
  readonly replayMs?: number;
  /** Over this many queued frames the stream gets `bye`. Default 256. */
  readonly subscriberFrames?: number;
};

const limitsSchema = z
  .object({
    /** Tags are unioned for this long (a fixed window, so a write storm still flushes). */
    batchMs: z.int().positive().default(20),
    /** The ring's hard cap: reaching it starts a new epoch (an overload). */
    replayFrames: z.int().positive().default(65_536),
    /** The age up to which a cursor resumes; frames older than this are evicted. */
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
  /** Makes the cursor key, then starts the source. Rejects with E001 where WebCrypto (`crypto.subtle`) is missing. */
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): 'idle' | 'ready' | 'unavailable' | 'stopped';
  /**
   * Attaches a stream once its cursor is opened. Rejects with E003 unless the hub is `ready`, E004
   * for a malformed cursor. A well-formed cursor this hub cannot open resumes nothing: it resets.
   */
  open(options: { readonly cursor?: LiveCursor; readonly signal: AbortSignal }): Promise<AsyncIterable<LiveFeed>>;
  /**
   * The current position as a new opaque cursor, or `undefined` while the hub is not `ready`. The
   * position is taken when this is called, so call it before reading the data a server-rendered
   * page dehydrates: a client that connects with it replays every commit after that read.
   */
  cursor(): Promise<LiveCursor | undefined>;
  connections(): number;
};

type ChangeFrame = Extract<LiveFeed, { kind: 'change' }>;
type EndFrame = Extract<LiveEvent, { kind: 'gap' | 'bye' }>;
/** A frame as the hub holds it: its position, and its cursor, sealed on first use and shared by every stream. */
type HeldChange = Omit<ChangeFrame, 'cursor'> & {
  readonly at: CursorPosition;
  readonly cursor: () => Promise<LiveCursor>;
};
type Held = { readonly kind: 'begin'; readonly mode: 'resume' | 'reset'; readonly at: CursorPosition } | HeldChange;

type Subscriber = {
  /** `begin` and the replay, captured at attach. Not counted against `subscriberFrames`. */
  preamble: readonly Held[];
  preambleAt: number;
  /** Live frames not yet taken. */
  pending: HeldChange[];
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

function take(subscriber: Subscriber): Held | EndFrame | undefined {
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
  /** Seals and opens cursors; made by `start()` before the source can report `ready`. */
  let cipher: CursorCipher | undefined;
  let epoch = '';
  let seq = 0;
  const ring = replayRing<HeldChange>({ ms: limits.replayMs });
  /** The open batch: each table, with the transactions that wrote it. */
  const batch = new Map<string, { readonly tag: TableTag; readonly txids: Set<string> }>();
  /** Every transaction of the open batch, for the per-frame cap. */
  const batchTxIds = new Set<string>();
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  const subscribers = new Set<Subscriber>();

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

  function deliver(subscriber: Subscriber, frame: HeldChange): void {
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
    if (state !== 'ready' || cipher === undefined || tables.length === 0) return;
    const sealer = cipher;
    const now = Date.now();
    ring.evict(now);
    for (let from = 0; from < tables.length; from += MAX_TAGS_PER_FRAME) {
      if (ring.size() >= limits.replayFrames) {
        overload();
        return;
      }
      seq += 1;
      const part = tables.slice(from, from + MAX_TAGS_PER_FRAME);
      const txidsByTag = part.map(entry => [...entry.txids]);
      const at: CursorPosition = { epoch, seq, at: now };
      let sealed: Promise<LiveCursor> | undefined;
      // Each frame names exactly the transactions that wrote its own tables.
      const frame: HeldChange = {
        kind: 'change',
        at,
        cursor: () => (sealed ??= sealer.seal(at)),
        tags: part.map(entry => entry.tag),
        txids: [...new Set(txidsByTag.flat())],
        txidsByTag,
      };
      ring.add(seq, now, frame);
      for (const subscriber of subscribers) deliver(subscriber, frame);
    }
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

  /**
   * The ring reached its cap: a new epoch, every stream ends with `gap`, every client resets. The
   * frame being flushed is not sent: the resets refetch every live query, which covers it.
   */
  function overload(): void {
    debugHub.warn(
      '{epoch}: overloaded: the replay ring reached its cap of {cap} frames within {replayMs} ms; starting a new epoch, {streams} streams reset',
      { epoch, cap: limits.replayFrames, frames: ring.size(), replayMs: limits.replayMs, streams: subscribers.size },
    );
    beginEpoch();
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

  /**
   * The frames to replay after `position`, or `undefined` for a reset: another epoch, older than
   * `replayMs` (by its own age only, whatever happened since), or from the future.
   */
  function replayAfter(position: CursorPosition, now: number): readonly HeldChange[] | undefined {
    if (position.epoch !== epoch || now - position.at > limits.replayMs) return undefined;
    return ring.after(position.seq, seq);
  }

  function assertReady(): CursorCipher {
    if (state !== 'ready' || cipher === undefined) {
      throw liveError(
        LIVE_ERROR_CODES.source,
        `the live hub is ${state}, not ready`,
        'Retry with backoff: the hub is ready again once its Postgres listener is back.',
      );
    }
    return cipher;
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

  /** A held item as the wire sees it: positions sealed into fresh cursors. */
  async function reveal(item: Held | EndFrame, sealer: CursorCipher): Promise<LiveFeed> {
    switch (item.kind) {
      case 'begin': {
        return { kind: 'begin', mode: item.mode, cursor: await sealer.seal(item.at) };
      }
      case 'change': {
        const { tags, txids, txidsByTag } = item;
        return { kind: 'change', cursor: await item.cursor(), tags, txids, txidsByTag };
      }
      default: {
        return item;
      }
    }
  }

  async function* feed(subscriber: Subscriber, sealer: CursorCipher): AsyncGenerator<LiveFeed, void, undefined> {
    try {
      for (;;) {
        const item = take(subscriber);
        if (item) {
          yield await reveal(item, sealer);
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
      // `stop()` waits for this, then stops the source it resolved with. The key comes first, so
      // the source's first `ready` finds it.
      starting = cursorCipher()
        .then(made => {
          cipher = made;
          return options.source.start(receive);
        })
        .then(stop => {
          stopSource = stop;
        });
      return starting;
    },

    stop() {
      stopping ??= shutdown();
      return stopping;
    },

    status: () => state,

    async open({ cursor, signal }) {
      assertReady();
      if (cursor !== undefined && !liveCursorSchema.safeParse(cursor).success) {
        throw liveError(
          LIVE_ERROR_CODES.protocol,
          `malformed cursor ${JSON.stringify(cursor)}`,
          'Send back a cursor exactly as a frame gave it, or none.',
        );
      }
      const position = cursor === undefined ? undefined : await assertReady().open(cursor);
      // The hub may have changed while the cursor was opened: check again, then attach and read the
      // high-water mark in one synchronous step, so no frame can fall between them.
      const sealer = assertReady();
      const now = Date.now();
      ring.evict(now);
      const replay = position === undefined ? undefined : replayAfter(position, now);
      const preamble: readonly Held[] =
        position === undefined || replay === undefined
          ? [{ kind: 'begin', mode: 'reset', at: { epoch, seq, at: now } }]
          : [{ kind: 'begin', mode: 'resume', at: position }, ...replay];
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
      return feed(subscriber, sealer);
    },

    async cursor() {
      // The position is read now, before any await: what the caller reads afterwards is covered.
      if (state !== 'ready' || cipher === undefined) return;
      return cipher.seal({ epoch, seq, at: Date.now() });
    },

    connections: () => subscribers.size,
  };
}
