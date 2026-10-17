import { describe, expect, it } from 'vitest';

import type { ResolvedKeep } from './retention.js';
import { isJournalError } from './errors.js';
import { keepFor, keepUntil, parseAge, parseKeep, resolveRetention, retryableForMs } from './retention.js';

const now = new Date('2026-10-17T12:00:00.000Z');
const DAY = 86_400_000;

const stored = (keep: ResolvedKeep) => {
  if (!keep.store) throw new Error('expected a keep that stores the row');
  return keep;
};

describe('retention ages and keeps', () => {
  it("'30d', 3600 and { age, max } resolve to one keep_until and one cap, so every level speaks one type", () => {
    expect(keepUntil(stored(parseKeep('30d')), now)).toEqual(new Date(now.getTime() + 30 * DAY));
    expect(keepUntil(stored(parseKeep(3600)), now)).toEqual(new Date(now.getTime() + 3_600_000));
    const capped = stored(parseKeep({ age: '90d', max: 50_000 }));
    expect(keepUntil(capped, now)).toEqual(new Date(now.getTime() + 90 * DAY));
    expect(capped.max).toBe(50_000);
    expect(stored(parseKeep('30d')).max).toBeUndefined();
    expect(parseAge('90m')).toBe(90 * 60_000);
    expect(parseAge('2h')).toBe(2 * 3_600_000);
  });

  it("'forever' stores no keep_until, so the sweeper never deletes it by age", () => {
    expect(keepUntil(stored(parseKeep('forever')), now)).toBeNull();
    expect(keepUntil(stored(parseKeep({ age: 'forever', max: 10 })), now)).toBeNull();
  });

  it('false writes no archive row, so a finished job is deleted as it is today', () => {
    expect(parseKeep(false)).toEqual({ store: false });
  });

  it("'untilExported' expires at archive time, so the prune step deletes the row right after the sink has it", () => {
    const keep = stored(parseKeep('untilExported'));
    expect(keep.untilExported).toBe(true);
    expect(keepUntil(keep, now)).toEqual(now);
  });

  it('a bad age or cap is BAD_DEFINITION at boot, so a typo never becomes a silent default', () => {
    for (const bad of ['30', '30w', 'd', '-1d', Number.NaN, -5] as const) {
      expect(() => parseAge(bad as never)).toThrow();
    }
    let thrown: unknown;
    try {
      parseKeep('forevr' as never);
    } catch (error) {
      thrown = error;
    }
    expect(isJournalError(thrown, 'BAD_DEFINITION')).toBe(true);
    expect(() => parseKeep({ age: '1d', max: 0 })).toThrow();
    expect(() => parseKeep({ age: '1d', max: 1.5 })).toThrow();
  });
});

describe('retention resolution', () => {
  it('the defaults hold when nothing is set: completed 7d, dead 90d, retryable 30d, operations forever, sweep hourly', () => {
    const policy = resolveRetention(undefined);
    expect(policy.retryableForMs).toBe(30 * DAY);
    expect(stored(policy.completed).ageMs).toBe(7 * DAY);
    expect(stored(policy.dead).ageMs).toBe(90 * DAY);
    expect(stored(policy.operations).ageMs).toBeNull();
    expect(policy.sweep).toEqual({ everyMs: 3_600_000, batch: 1000 });
    expect(policy.sink).toBeUndefined();
  });

  it("per-effect retention wins over the journal's, and the journal's over the default", () => {
    const policy = resolveRetention({ archive: { completed: '2d' }, retryableFor: '10d' });
    // journal beats default
    expect(stored(keepFor(policy, 'completed', undefined)).ageMs).toBe(2 * DAY);
    expect(stored(keepFor(policy, 'dead', undefined)).ageMs).toBe(90 * DAY);
    expect(retryableForMs(policy, undefined)).toBe(10 * DAY);
    // effect beats journal, only for the class it names
    const effect = { completed: '1d', retryableFor: '2d' } as const;
    expect(stored(keepFor(policy, 'completed', effect)).ageMs).toBe(DAY);
    expect(stored(keepFor(policy, 'dead', effect)).ageMs).toBe(90 * DAY);
    expect(retryableForMs(policy, effect)).toBe(2 * DAY);
    // false at the effect level beats a stored journal default
    expect(keepFor(policy, 'completed', { completed: false })).toEqual({ store: false });
  });

  it('dead, discarded and cancelled share the dead class, so an operator removal is kept like a failure', () => {
    const policy = resolveRetention({ archive: { dead: '5d' } });
    for (const outcome of ['dead', 'discarded', 'cancelled'] as const) {
      expect(stored(keepFor(policy, outcome, undefined)).ageMs).toBe(5 * DAY);
    }
  });

  it('sweep: false is kept as false, so an app that schedules the verbs itself gets no worker sweeper', () => {
    expect(resolveRetention({ sweep: false }).sweep).toBe(false);
    expect(resolveRetention({ sweep: { every: '5m' } }).sweep).toEqual({ everyMs: 300_000, batch: 1000 });
    expect(() => resolveRetention({ sweep: { batch: 0 } })).toThrow();
  });
});
