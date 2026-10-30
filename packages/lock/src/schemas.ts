import { z } from 'zod';
import type { LockError } from './errors.js';
import { DURATION_UNITS, GUARANTEE_VALUES, MAX_PERMITS } from './types.js';
import { lockFenceSchema, lockKeySchema, lockTokenSchema, keyNameSchema, decodeKey } from './identity-schemas.js';

/** A number of milliseconds, or a string with unit `ms`, `s`, `m` or `h`. No days or weeks on purpose. */
export const durationSchema = z.union([
  z.number().finite().nonnegative(),
  z.templateLiteral([z.number().nonnegative(), z.enum(DURATION_UNITS)]),
]);


export { keyNameSchema } from './identity-schemas.js';

/** The largest limit or weight: Postgres stores them as `integer`. */
/** A semaphore size: a positive integer. */
export const limitSchema = z.number().int().positive().max(MAX_PERMITS);
/** How many permits one hold takes: a positive integer. */
export const weightSchema = z.number().int().positive().max(MAX_PERMITS);
/** `storeTimeout` in milliseconds, at least 1. */
export const storeTimeoutSchema = z.number().finite().min(1);
/** What `semaphore(key, config)` takes. */
export const semaphoreConfigSchema = z.object({ limit: limitSchema });

/** What a store promises. The types of every handle derive from this. */
export const guaranteesSchema = z
  .object({
    kind: z.enum(GUARANTEE_VALUES.kind),
    scope: z.enum(GUARANTEE_VALUES.scope),
    /** How blocking waits are implemented. */
    wait: z.enum(GUARANTEE_VALUES.wait),
    /** `readWrite()` is available. */
    shared: z.boolean(),
    /** `semaphore()` is available. */
    permits: z.boolean(),
    fence: z.union([z.enum(GUARANTEE_VALUES.fence), z.literal(false)]),
    releasedOnCrash: z.enum(GUARANTEE_VALUES.releasedOnCrash),
    /**
     * Whose clock decides expiry: `'store'` (the backend's own clock), `'host'` (the
     * machine's wall clock, shared by every holder on it — a jump forward expires
     * live locks), or `'none'` (nothing expires on a clock).
     */
    clock: z.enum(GUARANTEE_VALUES.clock),
    poolerSafe: z.boolean(),
    /** `'transaction'`: the lock ends with the caller's transaction, so a guard has no `release`. */
    releasedBy: z.enum(GUARANTEE_VALUES.releasedBy).optional(),
    /** `readWrite()` only. `true`: a waiting writer stops new readers. Absent or `false`: readers can starve a writer. */
    writerPreference: z.boolean().optional(),
    runtimes: z.array(z.enum(GUARANTEE_VALUES.runtime)).readonly(),
  })
  .readonly();

/** Canonical, length-delimited, versioned key. Built by `createKey`; see `key.ts`. */
export const keySchema = z.object({ namespace: keyNameSchema, name: keyNameSchema, full: lockKeySchema }).refine(key => {
  const decoded = decodeKey(key.full);
  return decoded?.namespace === key.namespace && decoded.name === key.name;
}).readonly();

/** What a store returns for a successful attempt. */
export const grantSchema = z
  .object({
    key: keySchema,
    token: lockTokenSchema,
    fence: lockFenceSchema.optional(),
    /** Store time, ms. */
    expiresAt: z.number().optional(),
    /** Store-private state, such as a pinned connection. */
    conn: z.unknown().optional(),
    /** Resolves when the store knows this hold is gone (connection died). Hold stores without renewals use it; never rejects. */
    lost: z.custom<Promise<LockError>>(value => value instanceof Promise).optional(),
  })
  .readonly();


export const clockValueSchema = z.number().finite();
