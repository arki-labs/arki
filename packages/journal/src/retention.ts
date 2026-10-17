import type { JournalTables } from './pg.js';
import { JournalError } from './errors.js';

/** Seconds, or a string with unit `m`, `h` or `d` (`'30d'`): the same shape `@arki/schedule` takes for its lock durations. */
export type RetentionAge = number | `${number}${'m' | 'h' | 'd'}`;

/**
 * What to do with a finished job's archive row.
 * - `false`: never written. The job is deleted the moment it finishes.
 * - `'forever'`: kept until someone deletes it.
 * - `'untilExported'`: kept only until the archive sink has it, then deleted. Needs a sink.
 * - an age: kept this long.
 * - `{ age, max }`: kept this long, and at most `max` rows per outcome and effect or job name (the oldest go first).
 */
export type Keep =
  | false
  | 'forever'
  | 'untilExported'
  | RetentionAge
  | { readonly age: RetentionAge | 'forever'; readonly max?: number };

/** A finished job as the archive stores it. */
export type ArchivedJob = JournalTables['jobArchive']['$inferSelect'];

/** Where archive rows go after the table. At-least-once: dedupe on `row.id`. */
export type ArchiveSink = {
  readonly name: string;
  write(rows: readonly ArchivedJob[], ctx: { readonly signal: AbortSignal }): Promise<void>;
};

/** The journal-wide policy. Every field is optional; the defaults are in {@link defaultRetention}. */
export type JobRetention = {
  /** A dead job stays in the hot table, retryable, this long; then the sweeper archives it. Default `'30d'`. */
  readonly retryableFor?: RetentionAge;
  readonly archive?: {
    /** Default `'7d'`. */
    readonly completed?: Keep;
    /** Outcomes dead, discarded and cancelled. Default `'90d'`. */
    readonly dead?: Keep;
    readonly sink?: ArchiveSink;
  };
  /** The operations audit. Default `'forever'`. */
  readonly operations?: Keep;
  /** Default `{ every: '1h', batch: 1000 }`. `false`: the app schedules the sweep verbs itself. */
  readonly sweep?: false | { readonly every?: RetentionAge; readonly batch?: number };
};

/** The per-effect (or per queue job name) override. */
export type EffectRetention = {
  readonly completed?: Keep;
  readonly dead?: Keep;
  readonly retryableFor?: RetentionAge;
};

/** An archive outcome. */
export type ArchiveOutcome = ArchivedJob['outcome'];

/** A {@link Keep} after parsing. */
export type ResolvedKeep =
  | { readonly store: false }
  | {
      readonly store: true;
      /** Milliseconds to keep the row; null keeps it forever. */
      readonly ageMs: number | null;
      /** Kept only until the sink has it. */
      readonly untilExported: boolean;
      /** Row cap per outcome and effect or job name. */
      readonly max: number | undefined;
    };

/** The journal-wide policy after parsing, defaults applied. */
export type ResolvedRetention = {
  readonly retryableForMs: number;
  readonly completed: ResolvedKeep;
  readonly dead: ResolvedKeep;
  readonly sink: ArchiveSink | undefined;
  readonly operations: ResolvedKeep;
  readonly sweep: false | { readonly everyMs: number; readonly batch: number };
};

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const AGE_PATTERN = /^(\d+(?:\.\d+)?)([mhd])$/;

const badRetention = (what: string, detail: string) => new JournalError('BAD_DEFINITION', 'retention', what, detail);

/** An age in milliseconds. A number is seconds. Throws `BAD_DEFINITION` on anything else. */
export function parseAge(age: RetentionAge): number {
  if (typeof age === 'number') {
    if (!Number.isFinite(age) || age < 0)
      throw badRetention(String(age), 'an age in seconds must be a finite number, 0 or more');
    return age * 1000;
  }
  const match = AGE_PATTERN.exec(age);
  const amount = match?.[1];
  const unit = match?.[2];
  if (amount === undefined || unit === undefined || (unit !== 'm' && unit !== 'h' && unit !== 'd')) {
    throw badRetention(JSON.stringify(age), "an age is a number of seconds or a string like '30d' (unit m, h or d)");
  }
  return Number(amount) * UNIT_MS[unit];
}

function parseMax(max: number | undefined): number | undefined {
  if (max === undefined) return undefined;
  if (!Number.isInteger(max) || max < 1) throw badRetention(String(max), '`max` must be a whole number, 1 or more');
  return max;
}

/** Parse one {@link Keep}. Throws `BAD_DEFINITION` on a bad age or `max`. */
export function parseKeep(keep: Keep): ResolvedKeep {
  if (keep === false) return { store: false };
  if (keep === 'forever') return { store: true, ageMs: null, untilExported: false, max: undefined };
  if (keep === 'untilExported') return { store: true, ageMs: 0, untilExported: true, max: undefined };
  if (typeof keep === 'object') {
    return {
      store: true,
      ageMs: keep.age === 'forever' ? null : parseAge(keep.age),
      untilExported: false,
      max: parseMax(keep.max),
    };
  }
  return { store: true, ageMs: parseAge(keep), untilExported: false, max: undefined };
}

const DEFAULT_SWEEP_BATCH = 1000;

/** The defaults, as the synthesis fixes them: completed 7d, dead 90d, retryable 30d, operations forever, sweep hourly. */
export const defaultRetention = {
  retryableFor: '30d',
  completed: '7d',
  dead: '90d',
  operations: 'forever',
  sweep: { every: '1h', batch: DEFAULT_SWEEP_BATCH },
} as const satisfies {
  readonly retryableFor: RetentionAge;
  readonly completed: Keep;
  readonly dead: Keep;
  readonly operations: Keep;
  readonly sweep: { readonly every: RetentionAge; readonly batch: number };
};

/** Parse the journal-wide policy and fill the defaults. Throws `BAD_DEFINITION` on a bad value. */
export function resolveRetention(retention: JobRetention | undefined): ResolvedRetention {
  const sweep = retention?.sweep;
  if (
    sweep !== undefined &&
    sweep !== false &&
    sweep.batch !== undefined &&
    (!Number.isInteger(sweep.batch) || sweep.batch < 1)
  ) {
    throw badRetention(String(sweep.batch), '`sweep.batch` must be a whole number, 1 or more');
  }
  return {
    retryableForMs: parseAge(retention?.retryableFor ?? defaultRetention.retryableFor),
    completed: parseKeep(retention?.archive?.completed ?? defaultRetention.completed),
    dead: parseKeep(retention?.archive?.dead ?? defaultRetention.dead),
    sink: retention?.archive?.sink,
    operations: parseKeep(retention?.operations ?? defaultRetention.operations),
    sweep:
      sweep === false
        ? false
        : {
            everyMs: parseAge(sweep?.every ?? defaultRetention.sweep.every),
            batch: sweep?.batch ?? defaultRetention.sweep.batch,
          },
  };
}

/**
 * The keep rule for one archived row: the effect's (or queue job name's) override if it names this class,
 * else the journal's, which already holds the default. `dead`, `discarded` and `cancelled` share the `dead` class.
 */
export function keepFor(
  policy: ResolvedRetention,
  outcome: ArchiveOutcome,
  override: EffectRetention | undefined,
): ResolvedKeep {
  if (outcome === 'completed') {
    return override?.completed === undefined ? policy.completed : parseKeep(override.completed);
  }
  return override?.dead === undefined ? policy.dead : parseKeep(override.dead);
}

/** How long a dead job stays retryable in the hot table, in milliseconds. */
export function retryableForMs(policy: ResolvedRetention, override: EffectRetention | undefined): number {
  return override?.retryableFor === undefined ? policy.retryableForMs : parseAge(override.retryableFor);
}

/**
 * The `keep_until` to store when a row is archived at `now`. Null keeps it forever.
 * `'untilExported'` stores `now`: the prune step deletes a row past `keep_until` once the sink has it,
 * so the row goes right after export. Call only when `keep.store` is true; a `false` keep writes no row.
 */
export function keepUntil(keep: Extract<ResolvedKeep, { store: true }>, now: Date): Date | null {
  return keep.ageMs === null ? null : new Date(now.getTime() + keep.ageMs);
}

/** An effect as retention sees it: its name and the override on its schedule. */
type RetentionSource = { readonly name: string; readonly schedule: { readonly retention?: EffectRetention } };

/**
 * The override for a job row's effect, by name. The one lookup the worker's ack and the operator verbs share, so a
 * job is archived under the same rule whoever removes it. Queue rows have none here: a queue job's override comes
 * from its runner, which only a worker holds.
 */
export function effectOverrides(
  effects: readonly RetentionSource[],
): (job: { readonly effect: string | null }) => EffectRetention | undefined {
  const byName = new Map(effects.map(effect => [effect.name, effect.schedule.retention]));
  return job => (job.effect === null ? undefined : byName.get(job.effect));
}

const needsSink = (keep: ResolvedKeep): boolean => keep.store && keep.untilExported;

/**
 * Boot check. `'untilExported'` means "keep only until the sink has it", so it needs a sink; effects are defined
 * before the runtime journal exists, so the type cannot say this and the journal checks it once, at init.
 * Also parses every effect override, so a bad age fails at init instead of at the first ack.
 */
export function assertRetention(policy: ResolvedRetention, effects: readonly RetentionSource[]): void {
  if (policy.sink === undefined && (needsSink(policy.completed) || needsSink(policy.dead))) {
    throw new JournalError(
      'BAD_DEFINITION',
      'retention',
      'journal',
      "journal: retention 'untilExported' needs `retention.archive.sink`; without one nothing is ever exported",
    );
  }
  for (const effect of effects) {
    const override = effect.schedule.retention;
    if (override === undefined) continue;
    const parsed = [override.completed, override.dead].flatMap(keep => (keep === undefined ? [] : [parseKeep(keep)]));
    if (override.retryableFor !== undefined) parseAge(override.retryableFor);
    if (policy.sink === undefined && parsed.some(keep => needsSink(keep))) {
      throw new JournalError(
        'BAD_DEFINITION',
        'effect',
        effect.name,
        `journal: effect "${effect.name}": retention 'untilExported' needs \`retention.archive.sink\`; without one nothing is ever exported`,
      );
    }
  }
}
