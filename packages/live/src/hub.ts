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
 * - Source `change`s of one transaction arrive in a row (NOTIFY keeps commit
 *   order); they become one envelope in the ring, numbered `seq`, with each
 *   table's changed keys (a scoped table) or the table as a whole. An envelope
 *   takes more of its transaction's changes until a position at it is handed
 *   out (a frame, a cursor, a reset): from then on its `seq` is fixed, so a
 *   later change of the same transaction becomes a new envelope.
 * - Each stream sees the hub through its view. Of each envelope it keeps the
 *   granted tables, of a scoped table only its granted keys (a scoped table
 *   without granted keys shows nothing), and, when anything is left, the
 *   transaction's receipt. An envelope that shows nothing never reaches the
 *   stream: it starts no timer, takes no queue slot, and counts toward no cap.
 *   So nothing a stream can observe (its frames, their size and timing, its
 *   queue, its `bye`) depends on writes its view hides.
 * - Each stream batches its own visible changes. The first one opens a
 *   `batchMs` window; when it closes (or holds 256 transactions) the stream
 *   gets the window's tables unioned, each scoped one with its keys, split at
 *   256 tags or 1024 keys per frame. A frame names the receipts of exactly the
 *   transactions that wrote its own tables and keys; raw transaction ids never
 *   leave the hub. Without `receipts`, frames name none.
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
 * - `replayEnvelopes` and `replayBytes` are hard caps, not evictions: a ring
 *   that reaches one means the hub is overloaded. It starts a new epoch and
 *   ends every stream with `gap`, so every client resets together; that
 *   reveals only "the hub was overloaded", the same to everyone. Logged at
 *   warn.
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
import { liveCursorSchema, MAX_KEYS_PER_FRAME, txIdSchema } from './schema.js';

/**
 * What a source reports: the listener is ready (or back), the listener lost continuity, or tables
 * changed at commit. A tag of a scoped table carries the changed `keys` (as Postgres prints them).
 * `txid` is the transaction's `pg_current_xact_id()` in decimal; it stays in the hub.
 */
export type LiveSourceEvent =
  | { readonly kind: 'ready' }
  | { readonly kind: 'gap' }
  | {
      readonly kind: 'change';
      readonly tags: readonly (TableTag & { readonly keys?: readonly string[] })[];
      readonly txid?: string;
    };

/** Where hints come from. `start` resolves with the function that stops it. */
export type LiveSource = { start(receive: (event: LiveSourceEvent) => void): Promise<() => Promise<void>> };

/**
 * What `authorize` grants one client. `tables` omitted: every table of the manifest. `scopes`, per
 * dimension: the keys whose changes it may see (at most 4 096 each, in any form Postgres reads for
 * the key kind), or `'all'`. A scoped table whose dimension the grant leaves out shows nothing.
 */
export type LiveGrant<Dimension extends string = string> = {
  readonly tables?: readonly TableTag[];
  readonly scopes?: Partial<Readonly<Record<Dimension, readonly string[] | 'all'>>>;
};

/**
 * What one stream sees, as the hub applies it. `tables` omitted: every table. A scoped table
 * shows only the keys `scopes` lists for it (`'all'`: every key), under the dimension `name`; a
 * changed key of a table with no entry is hidden, and so is a keyless change of a table whose
 * entry lists keys. Keys compare exactly: write them the way Postgres prints them.
 */
export type LiveView = {
  readonly tables?: readonly TableTag[];
  readonly scopes?: readonly {
    readonly tag: TableTag;
    readonly name: string;
    readonly keys: readonly string[] | 'all';
  }[];
};

/** The hub's bounds. Every one is a positive integer; omitted ones take the default. */
export type LiveLimits = {
  /** A stream unions its visible tables for this long, in ms, from the first one (a fixed window, so a write storm still flushes). Default 20. */
  readonly batchMs?: number;
  /**
   * The most envelopes the replay ring may hold (one per transaction). Reaching it is an overload:
   * a new epoch starts and every client resets together. Size it above `replayMs` × the peak commit
   * rate. Default 262 144 (about 2 000 commits a second at the default `replayMs`).
   */
  readonly replayEnvelopes?: number;
  /** The most bytes (estimated) the replay ring may hold; reaching it is an overload too. Default 64 MiB. */
  readonly replayBytes?: number;
  /** A cursor taken this many ms ago still resumes; older ones reset, and envelopes older than this are evicted. Default 120 000. */
  readonly replayMs?: number;
  /** Over this many queued frames the stream gets `bye`. Default 256. */
  readonly subscriberFrames?: number;
};

const limitsSchema = z
  .object({
    /** A stream's window: its visible tables are unioned this long from the first one. */
    batchMs: z.int().positive().default(20),
    /** The ring's hard cap, in envelopes: reaching it starts a new epoch (an overload). */
    replayEnvelopes: z.int().positive().default(262_144),
    /** The ring's hard cap, in estimated bytes: reaching it starts a new epoch (an overload). */
    replayBytes: z
      .int()
      .positive()
      .default(64 * 1024 * 1024),
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
   * Attaches a stream once its cursor is opened. It sees only what `view` shows (omitted: every
   * unscoped table). Rejects with E003 unless the hub is `ready`, E004 for a malformed cursor. A
   * well-formed cursor this hub cannot open resumes nothing: it resets.
   */
  open(options: {
    readonly cursor?: LiveCursor;
    readonly view?: LiveView;
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
type FrameTag = Extract<LiveEvent, { kind: 'change' }>['tags'][number];

/** One table's change: the table as a whole (`whole`, an unscoped hint), and/or changed keys. */
type Cell = { readonly tag: TableTag; readonly key: string; readonly whole: boolean; readonly keys: readonly string[] };

/** One transaction's changes as the ring keeps them: an envelope. */
type Envelope = {
  readonly seq: number;
  /** When it arrived (ms): its age in the ring, and the start of the window it opens. */
  readonly at: number;
  /** Per table (by `tagKey`): whether it changed as a whole, and its changed keys. Grows while the envelope is open. */
  readonly cells: Map<string, { readonly tag: TableTag; whole: boolean; readonly keys: Set<string> }>;
  /** The source's raw txid, which keeps the transaction's changes in one envelope. */
  readonly txid: string | undefined;
  /** Its transaction, when the source named one and the hub has receipts. The receipt is made once, on first use. */
  readonly transaction: { readonly txid: string; readonly receipt: ReceiptOf } | undefined;
  /** The last cursor sealed at this envelope's position, shared by every frame made there at that time. */
  sealed: { readonly at: number; readonly cursor: Promise<LiveCursor> } | undefined;
};

/** A stream's open window: its visible tables, each with the transactions that wrote it (as a whole, and per key). */
type Window = {
  readonly first: Envelope;
  readonly closesAt: number;
  readonly tables: Map<
    string,
    {
      readonly tag: TableTag;
      /** The dimension, when the stream sees this table by key. */
      readonly name: string | undefined;
      /** Whether it changed as a whole in this window: then the frame names the table without keys. */
      wholeSeen: boolean;
      /** The transactions that changed it as a whole. */
      readonly whole: Map<string, ReceiptOf>;
      readonly keys: Map<string, Map<string, ReceiptOf>>;
    }
  >;
  readonly txids: Set<string>;
};

/** A frame as a stream holds it: its cursor and receipts are made when the stream sends it. */
type HeldChange = {
  readonly kind: 'change';
  readonly tags: FrameTag[];
  readonly receipts: readonly ReceiptOf[];
  readonly cursor: () => Promise<LiveCursor>;
};
type Held = { readonly kind: 'begin'; readonly mode: 'resume' | 'reset'; readonly at: CursorPosition } | HeldChange;

/** A view as the hub reads it: granted tables by `tagKey` (`undefined`: every table), and keys per scoped table. */
type View = {
  readonly tables: ReadonlySet<string> | undefined;
  readonly scopes: ReadonlyMap<string, { readonly name: string; readonly keys: ReadonlySet<string> | 'all' }>;
};

type Subscriber = {
  readonly view: View;
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
/** An envelope's estimated size: a fixed part, and UTF-16 bytes plus a small overhead per table and per key. */
const ENVELOPE_BYTES = 64;
const ENTRY_BYTES = 16;
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

/** The view the hub applies, from its plain form. */
function viewOf(view: LiveView | undefined): View {
  return {
    tables: view?.tables === undefined ? undefined : new Set(view.tables.map(tag => tagKey(tag))),
    scopes: new Map(
      (view?.scopes ?? []).map(({ tag, name, keys }) => [
        tagKey(tag),
        { name, keys: keys === 'all' ? 'all' : new Set(keys) },
      ]),
    ),
  };
}

/**
 * What `view` shows of `cell`: the table as a whole, and the keys it may see. `undefined` when
 * nothing: an ungranted table, a key of a table it sees no key of, a keyless change of a table it
 * sees only some keys of.
 */
function project(
  view: View,
  cell: Cell,
): { readonly whole: boolean; readonly keys: readonly string[]; readonly name: string | undefined } | undefined {
  if (view.tables !== undefined && !view.tables.has(cell.key)) return undefined;
  const scope = view.scopes.get(cell.key);
  const whole = cell.whole && (scope === undefined || scope.keys === 'all');
  const granted = scope?.keys;
  const keys = granted === undefined ? [] : granted === 'all' ? cell.keys : cell.keys.filter(key => granted.has(key));
  if (!whole && keys.length === 0) return undefined;
  return { whole, keys, name: scope?.name };
}

/** Every cell of an envelope, as one delta. */
function cellsOf(envelope: Envelope): Cell[] {
  return [...envelope.cells].map(([key, cell]) => ({ tag: cell.tag, key, whole: cell.whole, keys: [...cell.keys] }));
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
  /** The envelope numbered `seq`, while this epoch has one. */
  let latest: Envelope | undefined;
  /**
   * `latest`, while it still takes more changes of its transaction: until a position at it is
   * handed out (a frame, a cursor, a reset). After that its `seq` is fixed for good.
   */
  let growing: Envelope | undefined;
  /** Txids arrived without `receipts`: said once, at debug. */
  let toldNoReceipts = false;
  const ring = replayRing<Envelope>({ ms: limits.replayMs });
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
   * The stream's view of `cells` of `envelope`: what it may see goes into the stream's window
   * (opened by this envelope when none is open). Returns the window, or `undefined` when the cells
   * show nothing: then the stream is left exactly as it was.
   */
  function admit(subscriber: Subscriber, envelope: Envelope, cells: readonly Cell[]): Window | undefined {
    let window = subscriber.window;
    let shown = false;
    const transaction = envelope.transaction;
    for (const cell of cells) {
      const visible = project(subscriber.view, cell);
      if (visible === undefined) continue;
      shown = true;
      window ??= { first: envelope, closesAt: envelope.at + limits.batchMs, tables: new Map(), txids: new Set() };
      const table = window.tables.get(cell.key) ?? {
        tag: cell.tag,
        name: visible.name,
        whole: new Map<string, ReceiptOf>(),
        keys: new Map<string, Map<string, ReceiptOf>>(),
        wholeSeen: false,
      };
      if (visible.whole) {
        table.wholeSeen = true;
        if (transaction !== undefined) table.whole.set(transaction.txid, transaction.receipt);
      }
      for (const key of visible.keys) {
        const receipts = table.keys.get(key) ?? new Map<string, ReceiptOf>();
        if (transaction !== undefined) receipts.set(transaction.txid, transaction.receipt);
        table.keys.set(key, receipts);
      }
      window.tables.set(cell.key, table);
    }
    if (!shown || window === undefined) return undefined;
    if (transaction !== undefined) window.txids.add(transaction.txid);
    subscriber.window = window;
    return window;
  }

  /** The cursor of position (`envelope`, `at`), sealed once for every frame made there at that time. */
  function sealAt(sealer: CursorCipher, envelope: Envelope, position: CursorPosition): Promise<LiveCursor> {
    if (envelope.sealed?.at !== position.at) envelope.sealed = { at: position.at, cursor: sealer.seal(position) };
    return envelope.sealed.cursor;
  }

  /**
   * The frames of a closed window, at position (`last`, `at`): split at 256 tags or 1024 keys, a
   * table seen as a whole as one tag, each frame naming the receipts of its own tables and keys.
   */
  function framesOf(sealer: CursorCipher, window: Window, last: Envelope, at: number): HeldChange[] {
    if (last === growing) growing = undefined;
    const end: CursorPosition = { epoch, seq: last.seq, at };
    const before: CursorPosition = { epoch, seq: window.first.seq - 1, at: window.first.at };
    let beforeCursor: Promise<LiveCursor> | undefined;
    type Part = { readonly tags: FrameTag[]; readonly receipts: Map<string, ReceiptOf>; keys: number };
    const parts: Part[] = [];
    let part: Part = { tags: [], receipts: new Map(), keys: 0 };
    const next = (): void => {
      parts.push(part);
      part = { tags: [], receipts: new Map(), keys: 0 };
    };
    const take = (receipts: ReadonlyMap<string, ReceiptOf>): void => {
      for (const [txid, receipt] of receipts) part.receipts.set(txid, receipt);
    };
    for (const table of window.tables.values()) {
      const { schema, table: name } = table.tag;
      if (table.wholeSeen || table.name === undefined) {
        if (part.tags.length >= MAX_TAGS_PER_FRAME) next();
        part.tags.push({ schema, table: name });
        take(table.whole);
        for (const receipts of table.keys.values()) take(receipts);
        continue;
      }
      let keys: string[] | undefined;
      for (const [key, receipts] of table.keys) {
        if (part.keys >= MAX_KEYS_PER_FRAME || (keys === undefined && part.tags.length >= MAX_TAGS_PER_FRAME)) {
          next();
          keys = undefined;
        }
        if (keys === undefined) {
          keys = [];
          part.tags.push({ schema, table: name, scope: { name: table.name, keys } });
        }
        keys.push(key);
        part.keys += 1;
        take(receipts);
      }
    }
    parts.push(part);
    return parts.map((frame, index) => ({
      kind: 'change',
      tags: frame.tags,
      receipts: [...frame.receipts.values()],
      cursor:
        index === parts.length - 1 ? () => sealAt(sealer, last, end) : () => (beforeCursor ??= sealer.seal(before)),
    }));
  }

  /** The window's timer: it closes at the hub's current position. */
  function closeWindow(subscriber: Subscriber): void {
    const window = subscriber.window;
    subscriber.timer = undefined;
    subscriber.window = undefined;
    if (window === undefined || latest === undefined || cipher === undefined) return;
    deliver(subscriber, framesOf(cipher, window, latest, Date.now()));
  }

  /** New `cells` of `envelope` reach every stream through its own view. A stream they show nothing to is not touched. */
  function append(sealer: CursorCipher, envelope: Envelope, cells: readonly Cell[]): void {
    for (const subscriber of subscribers) {
      const opens = subscriber.window === undefined;
      const window = admit(subscriber, envelope, cells);
      if (window === undefined) continue;
      if (window.txids.size >= MAX_TXIDS_PER_FRAME) {
        dropWindow(subscriber);
        deliver(subscriber, framesOf(sealer, window, envelope, envelope.at));
      } else if (opens) {
        subscriber.timer = setTimeout(() => closeWindow(subscriber), limits.batchMs);
      }
    }
  }

  /**
   * The frames a stream missed after its cursor, made by the same view and windows as live ones,
   * timed by when each envelope arrived. A window still open at `now` stays open, with its timer.
   */
  function replayInto(
    sealer: CursorCipher,
    subscriber: Subscriber,
    envelopes: readonly Envelope[],
    now: number,
  ): HeldChange[] {
    const frames: HeldChange[] = [];
    let previous: Envelope | undefined;
    for (const envelope of envelopes) {
      const open = subscriber.window;
      if (open !== undefined && previous !== undefined && envelope.at >= open.closesAt) {
        subscriber.window = undefined;
        frames.push(...framesOf(sealer, open, previous, open.closesAt));
      }
      const window = admit(subscriber, envelope, cellsOf(envelope));
      if (window !== undefined && window.txids.size >= MAX_TXIDS_PER_FRAME) {
        subscriber.window = undefined;
        frames.push(...framesOf(sealer, window, envelope, envelope.at));
      }
      previous = envelope;
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

  /** The transaction of an envelope: shared with the one before it when it is the same one, so one HMAC per transaction. */
  function transactionOf(txid: string | undefined): Envelope['transaction'] {
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
    growing = undefined;
    ring.clear();
    state = 'ready';
    debugHub.debug('{epoch}: ready', { epoch });
  }

  /**
   * The ring reached a cap: a new epoch, every stream ends with `gap`, every client resets. The
   * change that met the cap is not kept: the resets refetch every live query, which covers it.
   */
  function overload(): void {
    debugHub.warn(
      '{epoch}: overloaded: the replay ring reached its cap ({envelopes} envelopes, {bytes} bytes) within {replayMs} ms; starting a new epoch, {streams} streams reset',
      {
        epoch,
        envelopes: limits.replayEnvelopes,
        bytes: limits.replayBytes,
        held: ring.size(),
        heldBytes: ring.bytes(),
        replayMs: limits.replayMs,
        streams: subscribers.size,
      },
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
        growing = undefined;
        debugHub.debug('{epoch}: listener gap; streams ended', { epoch });
        return;
      }
      case 'change': {
        if (state !== 'ready' || cipher === undefined || event.tags.length === 0) return;
        const now = Date.now();
        ring.evict(now);
        change(cipher, event, now);
        return;
      }
    }
  }

  /**
   * Adds a source change to the open envelope of its transaction, or to a new one, and gives
   * every stream what is new. A change that adds nothing (a repeat) touches nothing.
   */
  function change(sealer: CursorCipher, event: Extract<LiveSourceEvent, { kind: 'change' }>, now: number): void {
    const target = event.txid !== undefined && growing?.txid === event.txid ? growing : undefined;
    const staged = new Map<string, { tag: TableTag; whole: boolean; keys: Set<string>; added: boolean }>();
    for (const { schema, table, keys } of event.tags) {
      const key = tagKey({ schema, table });
      const known = target?.cells.get(key);
      const entry = staged.get(key) ?? {
        tag: { schema, table },
        whole: false,
        keys: new Set<string>(),
        added: known === undefined,
      };
      if (keys === undefined) entry.whole ||= known?.whole !== true;
      else for (const changed of keys) if (known?.keys.has(changed) !== true) entry.keys.add(changed);
      staged.set(key, entry);
    }
    const cells: Cell[] = [];
    let bytes = target === undefined ? ENVELOPE_BYTES : 0;
    for (const [key, entry] of staged) {
      if (!entry.whole && entry.keys.size === 0) continue;
      const keys = [...entry.keys];
      cells.push({ tag: entry.tag, key, whole: entry.whole, keys });
      if (entry.added) bytes += key.length * 2 + ENTRY_BYTES;
      for (const changed of keys) bytes += changed.length * 2 + ENTRY_BYTES;
    }
    if (cells.length === 0) return;
    if ((target === undefined && ring.size() >= limits.replayEnvelopes) || ring.bytes() + bytes > limits.replayBytes) {
      overload();
      return;
    }
    let envelope = target;
    if (envelope === undefined) {
      envelope = {
        seq: seq + 1,
        at: now,
        cells: new Map(),
        txid: event.txid,
        transaction: transactionOf(event.txid),
        sealed: undefined,
      };
      seq = envelope.seq;
      latest = envelope;
      growing = envelope;
      ring.add(envelope.seq, now, envelope, bytes);
    } else {
      ring.grow(bytes);
    }
    for (const cell of cells) {
      const kept = envelope.cells.get(cell.key) ?? { tag: cell.tag, whole: false, keys: new Set<string>() };
      kept.whole ||= cell.whole;
      for (const key of cell.keys) kept.keys.add(key);
      envelope.cells.set(cell.key, kept);
    }
    append(sealer, envelope, cells);
    debugHub.debug('{epoch}: envelope {seq} {action} {tables} tables, {streams} streams', {
      epoch,
      seq,
      action: target === undefined ? 'with' : 'grew by',
      tables: cells.length,
      streams: subscribers.size,
    });
  }

  /**
   * The envelopes after `position`, or `undefined` for a reset: another epoch, older than
   * `replayMs` (by its own age only, whatever happened since), or from the future.
   */
  function replayAfter(position: CursorPosition, now: number): readonly Envelope[] | undefined {
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

    async open({ cursor, view, signal }) {
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
        view: viewOf(view),
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
      // A reset begins at the latest envelope: its position is out, so it takes no more changes.
      if (replay === undefined) growing = undefined;
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
      growing = undefined;
      return cipher.seal({ epoch, seq, at: Date.now() });
    },

    connections: () => subscribers.size,
  };
}
