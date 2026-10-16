/**
 * @internal The hub's replay ring: the last change frames, bounded by count
 * and by age. A cursor resumes only when every frame after it is still here;
 * if even one is gone the client resets, so a replay is never partial.
 */
export type ReplayRing<Frame> = {
  /** Appends frame `seq` (always one more than the last), made at `at` ms. */
  add(seq: number, at: number, frame: Frame): void;
  /** Drops the oldest frames while there are more than `frames`, or they are older than `ms` at `now`. */
  evict(now: number): void;
  /** Every frame after `seq`, in order; `undefined` when one of them was evicted or `seq` is past `last`. */
  after(seq: number, last: number): readonly Frame[] | undefined;
  /** Forgets every frame: a new epoch starts at sequence 0. */
  clear(): void;
};

type Entry<Frame> = { readonly seq: number; readonly at: number; readonly frame: Frame };

/** @internal */
export function replayRing<Frame>(bounds: { readonly frames: number; readonly ms: number }): ReplayRing<Frame> {
  const entries: Entry<Frame>[] = [];
  /** The highest sequence no longer kept: a cursor below it cannot resume. */
  let evictedThrough = 0;

  return {
    add(seq, at, frame) {
      entries.push({ seq, at, frame });
    },
    evict(now) {
      for (let oldest = entries[0]; oldest; oldest = entries[0]) {
        if (entries.length <= bounds.frames && now - oldest.at <= bounds.ms) return;
        entries.shift();
        evictedThrough = oldest.seq;
      }
    },
    after(seq, last) {
      if (seq < evictedThrough || seq > last) return;
      return entries.filter(entry => entry.seq > seq).map(entry => entry.frame);
    },
    clear() {
      entries.length = 0;
      evictedThrough = 0;
    },
  };
}
