/**
 * @internal The hub's replay ring: the last envelopes (one per transaction),
 * bounded by age only. A cursor resumes only when every envelope after it is
 * still here; if even one is gone the client resets, so a replay is never
 * partial.
 *
 * Never by count or size: envelopes a client cannot see count too, so such a
 * bound would let a client learn from a reset that many hidden writes
 * happened. The hub's hard caps on the ring's entries and bytes are not
 * evictions: reaching one starts a new epoch, and every client resets
 * together (`hub.ts`).
 */
export type ReplayRing<Frame> = {
  /** Appends frame `seq` (always one more than the last), made at `at` ms, of about `bytes` bytes. */
  add(seq: number, at: number, frame: Frame, bytes: number): void;
  /** The last frame grew by about `bytes` bytes. */
  grow(bytes: number): void;
  /** Drops the oldest frames while they are older than `ms` at `now`. */
  evict(now: number): void;
  /** Every frame after `seq`, in order; `undefined` when one of them was evicted or `seq` is past `last`. */
  after(seq: number, last: number): readonly Frame[] | undefined;
  /** How many frames are kept. */
  size(): number;
  /** About how many bytes the kept frames hold. */
  bytes(): number;
  /** Forgets every frame: a new epoch starts at sequence 0. */
  clear(): void;
};

type Entry<Frame> = { readonly seq: number; readonly at: number; readonly frame: Frame; bytes: number };

/** @internal Frames are numbered without holes, so a sequence maps to its index: no scan per resume. */
export function replayRing<Frame>(bounds: { readonly ms: number }): ReplayRing<Frame> {
  let entries: Entry<Frame>[] = [];
  /** Index of the oldest kept entry; evicted ones before it are dropped in batches. */
  let head = 0;
  /** The highest sequence no longer kept: a cursor below it cannot resume. */
  let evictedThrough = 0;
  let total = 0;

  return {
    add(seq, at, frame, bytes) {
      entries.push({ seq, at, frame, bytes });
      total += bytes;
    },
    grow(bytes) {
      const last = entries.at(-1);
      if (last === undefined || entries.length === head) return;
      last.bytes += bytes;
      total += bytes;
    },
    evict(now) {
      for (let oldest = entries[head]; oldest; oldest = entries[head]) {
        if (now - oldest.at <= bounds.ms) break;
        head += 1;
        evictedThrough = oldest.seq;
        total -= oldest.bytes;
      }
      // Compact once the dead prefix is most of the array: amortised O(1) per frame.
      if (head > 1024 && head * 2 > entries.length) {
        entries = entries.slice(head);
        head = 0;
      }
    },
    after(seq, last) {
      if (seq < evictedThrough || seq > last) return;
      const first = entries[head];
      if (first === undefined) return [];
      return entries.slice(head + Math.max(0, seq - first.seq + 1)).map(entry => entry.frame);
    },
    size: () => entries.length - head,
    bytes: () => total,
    clear() {
      entries = [];
      head = 0;
      evictedThrough = 0;
      total = 0;
    },
  };
}
