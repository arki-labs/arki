/**
 * @internal The hub's replay ring: the last change frames, bounded by age
 * only. A cursor resumes only when every frame after it is still here; if
 * even one is gone the client resets, so a replay is never partial.
 *
 * Never by count: frames of tables a client cannot see count too, so a
 * count bound would let a client learn from a reset that many hidden frames
 * happened. The hub's hard cap on the ring's size is not an eviction: it
 * starts a new epoch, and every client resets together (`hub.ts`).
 */
export type ReplayRing<Frame> = {
  /** Appends frame `seq` (always one more than the last), made at `at` ms. */
  add(seq: number, at: number, frame: Frame): void;
  /** Drops the oldest frames while they are older than `ms` at `now`. */
  evict(now: number): void;
  /** Every frame after `seq`, in order; `undefined` when one of them was evicted or `seq` is past `last`. */
  after(seq: number, last: number): readonly Frame[] | undefined;
  /** How many frames are kept. */
  size(): number;
  /** Forgets every frame: a new epoch starts at sequence 0. */
  clear(): void;
};

type Entry<Frame> = { readonly seq: number; readonly at: number; readonly frame: Frame };

/** @internal Frames are numbered without holes, so a sequence maps to its index: no scan per resume. */
export function replayRing<Frame>(bounds: { readonly ms: number }): ReplayRing<Frame> {
  let entries: Entry<Frame>[] = [];
  /** Index of the oldest kept entry; evicted ones before it are dropped in batches. */
  let head = 0;
  /** The highest sequence no longer kept: a cursor below it cannot resume. */
  let evictedThrough = 0;

  return {
    add(seq, at, frame) {
      entries.push({ seq, at, frame });
    },
    evict(now) {
      for (let oldest = entries[head]; oldest; oldest = entries[head]) {
        if (now - oldest.at <= bounds.ms) break;
        head += 1;
        evictedThrough = oldest.seq;
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
    clear() {
      entries = [];
      head = 0;
      evictedThrough = 0;
    },
  };
}
