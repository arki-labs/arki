/**
 * The hub: turns source events (Postgres commits, in production) into
 * numbered hints in a bounded replay ring, and feeds every open stream its
 * own view of them. Portable: no Postgres code here; `@arki/live/pg` is one
 * source.
 *
 * The rules a client relies on:
 *
 * - An epoch is a random 12-character name. Every `ready` from the source
 *   starts a new one, so nothing resumes across a listener gap.
 * - Every source `change` is one hint in the ring, numbered `seq`.
 * - Each stream sees the hub through its grant. Of each hint it keeps the
 *   granted tables and, when one is left, the transaction's receipt. A hint
 *   with no granted table never reaches the stream: it starts no timer, takes
 *   no queue slot, and counts toward no cap. So nothing a stream can observe
 *   (its frames, their size and timing, its queue, its `bye`) depends on
 *   writes its grant hides.
 * - Each stream batches its own visible hints. The first one opens a
 *   `batchMs` window; when it closes (or holds 256 transactions) the stream
 *   gets the window's tables unioned, 256 per frame. A frame names the
 *   receipts of exactly the transactions that wrote its own tables; raw
 *   transaction ids never leave the hub. Without `receipts`, frames name none.
 * - Cursors are opaque: `(epoch, seq, at)` sealed with AES-GCM under a key
 *   made at `start()`, fresh IV every time (`cursor.ts`). A client cannot
 *   count the hints its grant hides from it. A cursor this hub cannot open is
 *   unknown and resets.
 * - A frame's cursor is the hub's position when the window closed: every
 *   later hint arrived after it. The parts of a split before the last carry
 *   the position before the window's first hint, so a disconnect mid-split
 *   replays the whole window (a client may get a table twice, never miss
 *   one). Streams whose windows close at one position share one sealed
 *   cursor: one AES-GCM call, not one per stream. `begin` cursors and
 *   `cursor()` are sealed fresh each time.
 * - A resume replays the hints after its cursor through the same view and
 *   the same windows, timed by when each hint arrived: the stream gets the
 *   frames it would have got had it stayed connected. A window still open at
 *   attach stays open and closes on time.
 * - `open()` opens the cursor, then attaches the stream and reads the ring's
 *   high-water mark in one synchronous step. Every later hint reaches it;
 *   every earlier one is in the replay or covered by a reset.
 * - Resume or reset depends on the cursor's age alone: a cursor of this
 *   epoch taken at most `replayMs` ago resumes, an older one resets. The ring
 *   evicts by that same age, and every hint after a cursor arrived after the
 *   cursor was taken, so every hint a young cursor needs is kept. Anything
 *   else (none, another epoch, from the future) resets. Never by count:
 *   hints of hidden tables count too, so a client could learn from a reset
 *   that many of them happened.
 * - `replayFrames` is a hard cap, not an eviction: a ring that reaches it
 *   means the hub is overloaded. It starts a new epoch and ends every stream
 *   with `gap`, so every client resets together; that reveals only "the hub
 *   was overloaded", the same to everyone. Logged at warn.
 * - A stream whose queue passes `subscriberFrames` gets `bye`: it reconnects
 *   with its cursor instead of buffering without bound.
 * - `stop()` is final and settles once: every stream gets `bye`, every
 *   window timer is cleared, and the promise resolves only after the source
 *   stopped (also when `start()` is still running). Every call returns that
 *   promise.
 */
import { z } from 'zod';

import type { CursorCipher, CursorPosition } from './cursor.js';
import type { LiveReceipts } from './receipts.js';
import type { LiveCursor, LiveEvent, LiveReceipt, TableTag } from './types.js';
import { cursorCipher } from './cursor.js';
import { debugHub } from './debug.js';
import { LIVE_ERROR_CODES, liveError } from './errors.js';
import { tagKey } from './manifest.js';
import { replayRing } from './replay.js';
import { liveCursorSchema, txIdSchema } from './schema.js';

/**
 * What a source reports: the listener is ready (or back), the listener lost continuity, or tables
 * changed at commit. `txid` is the transaction's `pg_current_xact_id()` in decimal; it stays in the hub.
 */
export type LiveSourceEvent =
  | { readonly kind: 'ready' }
  | { readonly kind: 'gap' }
  | { readonly kind: 'change'; readonly tags: readonly TableTag[]; readonly txid?: string };

/** Where hints come from. `start` resolves with the function that stops it. */
export type LiveSource = { start(receive: (event: LiveSourceEvent) => void): Promise<() => Promise<void>> };

/** What one stream may see. `tables` omitted: every table. */
export type LiveGrant = { readonly tables?: readonly TableTag[] };

/** The hub's bounds. Every one is a positive integer; omitted ones take the default. */
export type LiveLimits = {
  /** A stream unions its visible tables for this long, in ms, from the first one (a fixed window, so a write storm still flushes). Default 20. */
  readonly batchMs?: number;
  /**
   * The most hints the replay ring may hold (one per table per commit). Reaching it is an
   * overload: a new epoch starts and every client resets together. Size it above `replayMs` × the
   * peak hint rate. Default 262 144 (about 2 000 hints a second at the default `replayMs`).
   */
  readonly replayFrames?: number;
  /** A cursor taken this many ms ago still resumes; older ones reset, and hints older than this are evicted. Default 120 000. */
  readonly replayMs?: number;
  /** Over this many queued frames the stream gets `bye`. Default 256. */
  readonly subscriberFrames?: number;
};

const limitsSchema = z
  .object({
    /** A stream's window: its visible tables are unioned this long from the first one. */
    batchMs: z.int().positive().default(20),
    /** The ring's hard cap, in hints: reaching it starts a new epoch (an overload). */
    replayFrames: z.int().positive().default(262_144),
    /** The age up to which a cursor resumes; hints older than this are evicted. */
    replayMs: z.int().positive().default(120_000),
    /** Over this many queued frames the stream gets `bye`. */
    subscriberFrames: z.int().positive().default(256),
  })
  .strict() satisfies z.ZodType<Required<LiveLimits>, LiveLimits>;

/** What one stream yields: `begin` once, then `change` frames, ending with `gap` or `bye` when the hub ends it. */
export type LiveFeed =
  | { readonly kind: 'begin'; readonly mode: 'resume' | 'reset'; readonly cursor: LiveCursor }
  | Extract<LiveEvent, { kind: 'change' | 'gap' | 'bye' }>;

export type LiveHub = {
  /** Makes the cursor key, then starts the source. Rejects with E001 where WebCrypto (`crypto.subtle`) is missing. */
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): 'idle' | 'ready' | 'unavailable' | 'stopped';
  /**
   * Attaches a stream once its cursor is opened. It sees only what `grant` shows (omitted: every
   * table). Rejects with E003 unless the hub is `ready`, E004 for a malformed cursor. A
   * well-formed cursor this hub cannot open resumes nothing: it resets.
   */
  open(options: {
    readonly cursor?: LiveCursor;
    readonly grant?: LiveGrant;
    readonly signal: AbortSignal;
  }): Promise<AsyncIterable<LiveFeed>>;
  /**
   * The current position as a new opaque cursor, or `undefined` while the hub is not `ready`. The
   * position is taken when this is called, so call it before reading the data a server-rendered
   * page dehydrates: a client that connects with it replays every commit after that read.
   */
  cursor(): Promise<LiveCursor | undefined>;
  connections(): number;
};

type EndFrame = Extract<LiveEvent, { kind: 'gap' | 'bye' }>;
type ReceiptOf = () => Promise<LiveReceipt>;

/** One source `change` as the ring keeps it. */
type Hint = {
  readonly seq: number;
  /** When it arrived (ms): its age in the ring, and the start of the window it opens. */
  readonly at: number;
  readonly cells: readonly { readonly tag: TableTag; readonly key: string }[];
  /** Its transaction, when the source named one and the hub has receipts. The receipt is made once, on first use. */
  readonly transaction: { readonly txid: string; readonly receipt: ReceiptOf } | undefined;
  /** The last cursor sealed at this hint's position, shared by every frame made there at that time. */
  sealed: { readonly at: number; readonly cursor: Promise<LiveCursor> } | undefined;
};

/** A stream's open window: its visible tables, each with the transactions that wrote it. */
type Window = {
  readonly first: Hint;
  readonly closesAt: number;
  readonly tables: Map<string, { readonly tag: TableTag; readonly receipts: Map<string, ReceiptOf> }>;
  readonly txids: Set<string>;
};

/** A frame as a stream holds it: its cursor and receipts are made when the stream sends it. */
type HeldChange = {
  readonly kind: 'change';
  readonly tags: TableTag[];
  readonly receipts: readonly ReceiptOf[];
  readonly cursor: () => Promise<LiveCursor>;
};
type Held = { readonly kind: 'begin'; readonly mode: 'resume' | 'reset'; readonly at: CursorPosition } | HeldChange;

type Subscriber = {
  /** The keys of the granted tables; `undefined`: every table. */
  readonly visible: ReadonlySet<string> | undefined;
  /** `begin` and the replay, captured at attach. Not counted against `subscriberFrames`. */
  preamble: Held[];
  preambleAt: number;
  /** Live frames not yet taken. */
  pending: HeldChange[];
  window: Window | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Delivered after everything queued before it; then the stream ends. */
  end: EndFrame | undefined;
  done: boolean;
  wake: (() => void) | undefined;
  unlisten: () => void;
};

const MAX_TAGS_PER_FRAME = 256;
/** A window that reaches this many transactions closes at once: no frame can name more. */
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

/** Drops the stream's open window and its timer. */
function dropWindow(subscriber: Subscriber): void {
  if (subscriber.timer !== undefined) clearTimeout(subscriber.timer);
  subscriber.timer = undefined;
  subscriber.window = undefined;
}

export function createLiveHub(options: {
  readonly source: LiveSource;
  readonly limits?: LiveLimits;
  readonly epoch?: () => string;
  /** Turns transaction ids into the receipts frames carry. Omitted: frames carry none, and `awaitTxId` cannot resolve by receipt. */
  readonly receipts?: LiveReceipts;
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
  const { receipts } = options;

  let state: 'idle' | 'ready' | 'unavailable' | 'stopped' = 'idle';
  /** The source's start, once `start()` was called. */
  let starting: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let stopSource: (() => Promise<void>) | undefined;
  /** Seals and opens cursors; made by `start()` before the source can report `ready`. */
  let cipher: CursorCipher | undefined;
  let epoch = '';
  let seq = 0;
  /** The hint numbered `seq`, while this epoch has one. */
  let latest: Hint | undefined;
  /** Txids arrived without `receipts`: said once, at debug. */
  let toldNoReceipts = false;
  const ring = replayRing<Hint>({ ms: limits.replayMs });
  const subscribers = new Set<Subscriber>();

  /** The hub ends the stream: queued frames are dropped, `end` is the last thing it yields. Safe inside a loop over `subscribers` (a Set skips deleted entries). */
  function finish(subscriber: Subscriber, end: EndFrame): void {
    subscribers.delete(subscriber);
    subscriber.unlisten();
    dropWindow(subscriber);
    subscriber.preamble = [];
    subscriber.pending = [];
    subscriber.end = end;
    wake(subscriber);
  }

  /** The consumer ended the stream (abort or `return()`): nothing more is yielded. */
  function close(subscriber: Subscriber): void {
    subscribers.delete(subscriber);
    subscriber.unlisten();
    dropWindow(subscriber);
    subscriber.preamble = [];
    subscriber.pending = [];
    subscriber.end = undefined;
    subscriber.done = true;
    wake(subscriber);
  }

  /** Queues live frames; past `subscriberFrames` the stream gets `bye` instead. */
  function deliver(subscriber: Subscriber, frames: readonly HeldChange[]): void {
    subscriber.pending.push(...frames);
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

  /**
   * The stream's view of `hint`: its granted tables go into the stream's window (opened by this
   * hint when none is open). Returns the window, or `undefined` when the hint shows nothing: then
   * the stream is left exactly as it was.
   */
  function admit(subscriber: Subscriber, hint: Hint): Window | undefined {
    let window = subscriber.window;
    let shown = false;
    for (const { tag, key } of hint.cells) {
      if (subscriber.visible !== undefined && !subscriber.visible.has(key)) continue;
      shown = true;
      window ??= { first: hint, closesAt: hint.at + limits.batchMs, tables: new Map(), txids: new Set() };
      const table = window.tables.get(key) ?? { tag, receipts: new Map<string, ReceiptOf>() };
      if (hint.transaction !== undefined) table.receipts.set(hint.transaction.txid, hint.transaction.receipt);
      window.tables.set(key, table);
    }
    if (!shown || window === undefined) return undefined;
    if (hint.transaction !== undefined) window.txids.add(hint.transaction.txid);
    subscriber.window = window;
    return window;
  }

  /** The cursor of position (`hint`, `at`), sealed once for every frame made there at that time. */
  function sealAt(sealer: CursorCipher, hint: Hint, position: CursorPosition): Promise<LiveCursor> {
    if (hint.sealed?.at !== position.at) hint.sealed = { at: position.at, cursor: sealer.seal(position) };
    return hint.sealed.cursor;
  }

  /** The frames of a closed window, at position (`last`, `at`): 256 tables each, each naming the receipts of its own tables. */
  function framesOf(sealer: CursorCipher, window: Window, last: Hint, at: number): HeldChange[] {
    const tables = [...window.tables.values()];
    const end: CursorPosition = { epoch, seq: last.seq, at };
    const before: CursorPosition = { epoch, seq: window.first.seq - 1, at: window.first.at };
    let beforeCursor: Promise<LiveCursor> | undefined;
    const frames: HeldChange[] = [];
    for (let from = 0; from < tables.length; from += MAX_TAGS_PER_FRAME) {
      const part = tables.slice(from, from + MAX_TAGS_PER_FRAME);
      const byTxid = new Map<string, ReceiptOf>();
      for (const table of part) for (const [txid, receipt] of table.receipts) byTxid.set(txid, receipt);
      const isLast = from + MAX_TAGS_PER_FRAME >= tables.length;
      frames.push({
        kind: 'change',
        tags: part.map(table => table.tag),
        receipts: [...byTxid.values()],
        cursor: isLast ? () => sealAt(sealer, last, end) : () => (beforeCursor ??= sealer.seal(before)),
      });
    }
    return frames;
  }

  /** The window's timer: it closes at the hub's current position. */
  function closeWindow(subscriber: Subscriber): void {
    const window = subscriber.window;
    subscriber.timer = undefined;
    subscriber.window = undefined;
    if (window === undefined || latest === undefined || cipher === undefined) return;
    deliver(subscriber, framesOf(cipher, window, latest, Date.now()));
  }

  /** A new hint reaches every stream through its own view. A stream it shows nothing to is not touched. */
  function append(sealer: CursorCipher, hint: Hint): void {
    for (const subscriber of subscribers) {
      const opens = subscriber.window === undefined;
      const window = admit(subscriber, hint);
      if (window === undefined) continue;
      if (window.txids.size >= MAX_TXIDS_PER_FRAME) {
        dropWindow(subscriber);
        deliver(subscriber, framesOf(sealer, window, hint, hint.at));
      } else if (opens) {
        subscriber.timer = setTimeout(() => closeWindow(subscriber), limits.batchMs);
      }
    }
  }

  /**
   * The frames a stream missed after its cursor, made by the same view and windows as live ones,
   * timed by when each hint arrived. A window still open at `now` stays open, with its timer.
   */
  function replayInto(sealer: CursorCipher, subscriber: Subscriber, hints: readonly Hint[], now: number): HeldChange[] {
    const frames: HeldChange[] = [];
    let previous: Hint | undefined;
    for (const hint of hints) {
      const open = subscriber.window;
      if (open !== undefined && previous !== undefined && hint.at >= open.closesAt) {
        subscriber.window = undefined;
        frames.push(...framesOf(sealer, open, previous, open.closesAt));
      }
      const window = admit(subscriber, hint);
      if (window !== undefined && window.txids.size >= MAX_TXIDS_PER_FRAME) {
        subscriber.window = undefined;
        frames.push(...framesOf(sealer, window, hint, hint.at));
      }
      previous = hint;
    }
    const open = subscriber.window;
    if (open !== undefined && previous !== undefined) {
      if (open.closesAt <= now) {
        subscriber.window = undefined;
        frames.push(...framesOf(sealer, open, previous, open.closesAt));
      } else {
        subscriber.timer = setTimeout(() => closeWindow(subscriber), open.closesAt - now);
      }
    }
    return frames;
  }

  /** The transaction of a hint: shared with the hint before it when it is the same one, so one HMAC per transaction. */
  function transactionOf(txid: string | undefined): Hint['transaction'] {
    if (txid === undefined) return undefined;
    if (receipts === undefined) {
      if (!toldNoReceipts) {
        toldNoReceipts = true;
        debugHub.debug('{epoch}: hints carry txids but the hub has no receipts: frames carry none', { epoch });
      }
      return undefined;
    }
    if (!txIdSchema.safeParse(txid).success) {
      debugHub.warn('{epoch}: the source sent a txid that is not a decimal xid8; dropped it', { epoch });
      return undefined;
    }
    if (latest?.transaction?.txid === txid) return latest.transaction;
    let made: Promise<LiveReceipt> | undefined;
    return { txid, receipt: () => (made ??= receipts.of(txid)) };
  }

  function beginEpoch(): void {
    // A second `ready` without a `gap` still means the listener reconnected: continuity is unknown.
    for (const subscriber of subscribers) finish(subscriber, { kind: 'gap' });
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
    latest = undefined;
    ring.clear();
    state = 'ready';
    debugHub.debug('{epoch}: ready', { epoch });
  }

  /**
   * The ring reached its cap: a new epoch, every stream ends with `gap`, every client resets. The
   * hint that met the cap is not kept: the resets refetch every live query, which covers it.
   */
  function overload(): void {
    debugHub.warn(
      '{epoch}: overloaded: the replay ring reached its cap of {cap} hints within {replayMs} ms; starting a new epoch, {streams} streams reset',
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
        for (const subscriber of subscribers) finish(subscriber, { kind: 'gap' });
        latest = undefined;
        debugHub.debug('{epoch}: listener gap; streams ended', { epoch });
        return;
      }
      case 'change': {
        if (state !== 'ready' || cipher === undefined || event.tags.length === 0) return;
        const now = Date.now();
        ring.evict(now);
        if (ring.size() >= limits.replayFrames) {
          overload();
          return;
        }
        const hint: Hint = {
          seq: seq + 1,
          at: now,
          cells: event.tags.map(tag => ({ tag, key: tagKey(tag) })),
          transaction: transactionOf(event.txid),
          sealed: undefined,
        };
        seq = hint.seq;
        latest = hint;
        ring.add(hint.seq, now, hint);
        append(cipher, hint);
        debugHub.debug('{epoch}: hint {seq} with {tables} tables, {streams} streams', {
          epoch,
          seq,
          tables: hint.cells.length,
          streams: subscribers.size,
        });
        return;
      }
    }
  }

  /**
   * The hints after `position`, or `undefined` for a reset: another epoch, older than `replayMs`
   * (by its own age only, whatever happened since), or from the future.
   */
  function replayAfter(position: CursorPosition, now: number): readonly Hint[] | undefined {
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

  /** A held item as the wire sees it: positions sealed into cursors, transactions into receipts. */
  async function reveal(item: Held | EndFrame, sealer: CursorCipher): Promise<LiveFeed> {
    switch (item.kind) {
      case 'begin': {
        return { kind: 'begin', mode: item.mode, cursor: await sealer.seal(item.at) };
      }
      case 'change': {
        const [cursor, txids] = await Promise.all([item.cursor(), Promise.all(item.receipts.map(of => of()))]);
        return { kind: 'change', cursor, tags: item.tags, txids };
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

    async open({ cursor, grant, signal }) {
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
      // high-water mark in one synchronous step, so no hint can fall between them.
      const sealer = assertReady();
      const now = Date.now();
      ring.evict(now);
      const replay = position === undefined ? undefined : replayAfter(position, now);
      const onAbort = (): void => close(subscriber);
      const subscriber: Subscriber = {
        visible: grant?.tables === undefined ? undefined : new Set(grant.tables.map(tag => tagKey(tag))),
        preamble: [],
        preambleAt: 0,
        pending: [],
        window: undefined,
        timer: undefined,
        end: undefined,
        done: false,
        wake: undefined,
        unlisten: () => signal.removeEventListener('abort', onAbort),
      };
      subscriber.preamble =
        position === undefined || replay === undefined
          ? [{ kind: 'begin', mode: 'reset', at: { epoch, seq, at: now } }]
          : [{ kind: 'begin', mode: 'resume', at: position }, ...replayInto(sealer, subscriber, replay, now)];
      subscribers.add(subscriber);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) close(subscriber);
      debugHub.debug('{epoch}: stream opened ({mode}, {replay} frames to replay)', {
        epoch,
        mode: replay === undefined ? 'reset' : 'resume',
        replay: subscriber.preamble.length - 1,
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
