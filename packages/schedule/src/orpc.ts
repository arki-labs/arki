/**
 * `@arki/schedule/orpc` — serve feature schedules as oRPC cron procedures.
 *
 * `POST /<name>` triggers the schedule named `<name>`. This file is machinery
 * only: the contract shape, the reply values and the dispatch. What each
 * outcome answers (status, body, who reports it) is the app's policy, and
 * the auth scheme is the app's middleware. RFC:
 * `docs/rfcs/2026-10-15-dot-feature-builder-cron.md`.
 *
 * No `node:` import, no auth, no logging — it runs on every runtime.
 */
import type { AnyContractProcedure, AnySchema, InferSchemaOutput, Schema } from '@orpc/contract';
import type { Router } from '@orpc/server';
import { oc } from '@orpc/contract';
import { ORPCError } from '@orpc/server';

import type { AnyDefinedFeature } from '@arki/dot/feature';
import { UnexpectedDefect } from '@arki/failure';

import type { ScheduleNameOf, ScheduleOutcome, ScheduleValueOf } from './dot.js';

/* ---------------- contract ---------------- */

/** The 200 body a cron answers when another run holds its lock (unless its spec says otherwise). */
export const lockHeld = { skipped: 'lock-held' } as const;

/** Per cron, by hand: the 200 body schema and, rarely, a legacy lock-held body (also a 200). */
export type CronSpec = AnySchema | { readonly body: AnySchema; readonly skipped: Readonly<Record<string, unknown>> };
export type CronSpecs = Readonly<Record<string, CronSpec>>;
export type BodyOf<S extends CronSpec> = S extends { readonly body: infer B extends AnySchema } ? B : S;
type SkippedOf<S extends CronSpec> = S extends { readonly skipped: infer K } ? K : typeof lockHeld;
/** The body type a cron's spec puts on the wire for a run. */
export type CronBody<S extends CronSpec> = InferSchemaOutput<BodyOf<S>>;
type CronMeta = { readonly cron: { readonly skipped: Readonly<Record<string, unknown>> } };
/** What the handler returns (oRPC "detailed" output): the 2xx reply. */
export type Detailed<T> = { readonly status: number; readonly body: T };

const isSchema = (spec: CronSpec): spec is AnySchema => '~standard' in spec;
const bodyOf = (spec: CronSpec): AnySchema => (isSchema(spec) ? spec : spec.body);
const skippedOf = (spec: CronSpec): Readonly<Record<string, unknown>> => (isSchema(spec) ? lockHeld : spec.skipped);

/**
 * Validates the body against `schema`, and returns the ORIGINAL value, not the
 * parsed one. oRPC would send the parsed value, and zod rebuilds objects in
 * schema key order and strips unknown keys. We keep the original so the key
 * order stays as the run wrote it, for byte parity of cron responses.
 */
export function checkOnly<S extends AnySchema>(schema: S): Schema<unknown, InferSchemaOutput<S>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'arki-schedule',
      validate: async value => {
        const result = await schema['~standard'].validate(value);
        // Erasure seam: the schema just accepted `value`, so it IS the output type.
        return result.issues ? { issues: result.issues } : { value: value as InferSchemaOutput<S> };
      },
    },
  };
}

/** `{ status, body }` where body is the run's body or exactly the lock-held body. Returns its input. */
function detailedSchema<S extends CronSpec>(spec: S): Schema<unknown, Detailed<CronBody<S> | SkippedOf<S>>> {
  const body = bodyOf(spec);
  const skipped = JSON.stringify(skippedOf(spec));
  return {
    '~standard': {
      version: 1,
      vendor: 'arki-schedule',
      validate: async value => {
        if (typeof value !== 'object' || value === null || !('status' in value) || typeof value.status !== 'number') {
          return { issues: [{ message: 'Expected a detailed output { status, body }' }] };
        }
        const sent = 'body' in value ? value.body : undefined;
        if (JSON.stringify(sent) !== skipped) {
          const result = await body['~standard'].validate(sent);
          if (result.issues) return { issues: result.issues };
        }
        // Erasure seam: status and body were both checked above.
        return { value: value as Detailed<CronBody<S> | SkippedOf<S>> };
      },
    },
  };
}

function procedure<S extends CronSpec>(name: string, spec: S) {
  return oc
    .$meta<CronMeta>({ cron: { skipped: skippedOf(spec) } })
    .route({ method: 'POST', path: `/${name}`, outputStructure: 'detailed', tags: ['cron'] })
    .output(checkOnly(detailedSchema(spec)));
}
export type CronContract<B extends CronSpecs> = { readonly [K in keyof B]: ReturnType<typeof procedure<B[K]>> };

/**
 * The contract: names and 200 bodies by hand; method (`POST`) and path
 * (`/<name>`) are fixed. Spread per-feature pieces into one call.
 *
 * ```ts
 * export const cronContract = defineCronContract({ ...companionCronSpecs, ...pushCronSpecs });
 * ```
 */
export function defineCronContract<const B extends CronSpecs>(specs: B): CronContract<B> {
  const out: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(specs)) out[name] = procedure(name, spec);
  return out as CronContract<B>; // erasure seam: built key by key above, typed by the same map
}

/* ---------------- replies & policy ---------------- */

declare const exact: unique symbol;
/**
 * A 2xx reply with the body the contract declares. The optional, type-only
 * `[exact]` makes `Ok<T>` invariant in T: an `ok({ ...body, extra })` is not
 * an `Ok<Body>`, so a `respond` can neither drop nor invent a key.
 */
export type Ok<T> = { readonly ok: true; readonly body: T; readonly [exact]?: (body: T) => T };
/** A 4xx/5xx reply: sent as is (status + body), never as oRPC's error envelope. */
export type Fail = { readonly ok: false; readonly status: number; readonly body: unknown };
/** Leave oRPC with this cause: the host route rethrows it, so its own 500 boundary answers and reports. */
export type Rethrow = { readonly ok: false; readonly rethrow: unknown };
/** The cron's lock-held body. */
export type Skipped = { readonly ok: 'skipped' };
export type Reply<T> = Ok<T> | Fail | Rethrow | Skipped;

export const ok = <T>(body: T): Ok<T> => ({ ok: true, body });
export const skipped = (): Skipped => ({ ok: 'skipped' });
export const fail = (status: number, body: unknown): Fail => ({ ok: false, status, body });
export const rethrow = (cause: unknown): Rethrow => ({ ok: false, rethrow: cause });

export type CronContext = {
  readonly headers: Headers;
  readonly schedules: { trigger(name: string): Promise<ScheduleOutcome<unknown>> };
  /** Set by a procedure that wants the host to rethrow; read by the host route after `handle`. */
  readonly carry: { rethrow?: { readonly cause: unknown } };
};

/** A reply for an outcome that carries no value: the lock-held body, an error reply, or a rethrow. */
export type Valueless = Fail | Rethrow | Skipped;
/** The app's answer to the outcomes that carry no value. */
export type OutcomePolicy = {
  readonly skipped: (name: string) => Valueless;
  readonly failed: (name: string, cause: unknown) => Valueless;
  readonly unavailable: (name: string) => Valueless;
};

/** Supervision defects use the failure policy; domain refusals keep their explicit responder. */
type CronValue<F extends readonly AnyDefinedFeature[], K extends string> = Exclude<
  ScheduleValueOf<F, K>,
  ReturnType<typeof UnexpectedDefect>
>;

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Crons whose schedule value is not exactly the body schema: they MUST say how the value maps. */
type NeedsRespond<B extends CronSpecs, F extends readonly AnyDefinedFeature[]> = {
  [K in keyof B & string]: Exact<CronValue<F, K>, CronBody<B[K]>> extends true ? never : K;
}[keyof B & string];
type Respond<B extends CronSpecs, F extends readonly AnyDefinedFeature[], K extends keyof B & string> = (
  value: CronValue<F, K>,
) => Reply<CronBody<B[K]>>;

/**
 * The app's policy. `respond` maps a run's value to the reply (default: 200 +
 * value). It is required for every cron whose value is not exactly its body,
 * so a schema that drops or invents a key is a compile error ("property X is
 * missing in respond"), and the mapping that makes it exact is written there.
 */
export type CronPolicy<B extends CronSpecs, F extends readonly AnyDefinedFeature[]> = OutcomePolicy & {
  readonly respond: { readonly [K in NeedsRespond<B, F>]: Respond<B, F, K> } & {
    readonly [K in Exclude<keyof B & string, NeedsRespond<B, F>>]?: Respond<B, F, K>;
  };
};

type Undeclared<B, F extends readonly AnyDefinedFeature[]> = Exclude<keyof B & string, ScheduleNameOf<F>>;

/* ---------------- router ---------------- */

/** The parts of oRPC's implementer the router uses: a procedure builder per name, and `router`. */
type Builders = Record<string, { handler(fn: (o: { context: CronContext }) => Promise<unknown>): unknown }> & {
  router(r: Router<Record<string, AnyContractProcedure>, CronContext>): unknown;
};

/**
 * The router. Checked at the call: every name is a schedule of some feature,
 * and every 200 body schema is EXACTLY the type put on the wire (two-way), so
 * a schema cannot drop or invent a key. `cronImplementer` is the app's implementer of the
 * contract with the app's middlewares (its auth) already applied:
 *
 * ```ts
 * const cronImplementer = implement(cronContract).$context<CronContext>().use(cronSecret);
 * export const cronRouter = cronRouterFor(cronImplementer, cronContract, features, policy);
 * ```
 */
export function cronRouterFor<const B extends CronSpecs, const F extends readonly AnyDefinedFeature[]>(
  os: unknown,
  contract: CronContract<B>,
  features: F &
    ([Undeclared<B, F>] extends [never]
      ? unknown
      : { readonly 'SCHEDULE: cron name is not a schedule of any feature': Undeclared<B, F> }),
  policy: CronPolicy<B, F>,
): Router<CronContract<B>, CronContext> {
  void features; // type-only: the names and values above are checked against it
  // Erasure seams: the implementer, the contract and the policy are all
  // reached by name in the loop below; their per-name types were checked at
  // the call (signature above) and are restored on the way out.
  const builders = os as Builders;
  const procedures = contract as Readonly<Record<string, { readonly '~orpc': { readonly meta: CronMeta } }>>;
  const respond = policy.respond as Readonly<Record<string, ((value: unknown) => Reply<unknown>) | undefined>>;
  const handlers: Record<string, unknown> = {};
  for (const name of Object.keys(contract)) {
    const skippedBody = procedures[name]?.['~orpc'].meta.cron.skipped;
    handlers[name] = builders[name]?.handler(async ({ context }) => {
      const outcome = await context.schedules.trigger(name);
      return send(context, reply(outcome, name, respond[name], policy), skippedBody);
    });
  }
  // Erasure seam: one handler per contract key, built above.
  return builders.router(handlers as Router<Record<string, AnyContractProcedure>, CronContext>) as Router<
    CronContract<B>,
    CronContext
  >;
}

function reply(
  outcome: ScheduleOutcome<unknown>,
  name: string,
  respond: ((value: unknown) => Reply<unknown>) | undefined,
  policy: OutcomePolicy,
): Reply<unknown> {
  switch (outcome.status) {
    case 'ran': {
      if (UnexpectedDefect.is(outcome.value)) return policy.failed(name, outcome.value);
      return respond ? respond(outcome.value) : ok(outcome.value);
    }
    case 'refused': {
      if (UnexpectedDefect.is(outcome.failure)) return policy.failed(name, outcome.failure);
      return respond ? respond(outcome.failure) : policy.failed(name, outcome.failure);
    }
    case 'skipped-overlap':
    case 'skipped-lock': {
      return policy.skipped(name);
    }
    case 'handler-failed':
    case 'lock-failed': {
      return policy.failed(name, outcome.cause);
    }
    case 'unavailable':
    case 'unknown': {
      return policy.unavailable(name);
    }
  }
}

/** Ok → detailed 200; Skipped → the cron's lock-held body; Fail → ORPCError with the exact body; Rethrow → carried, then thrown. */
function send(context: CronContext, r: Reply<unknown>, skippedBody: unknown): Detailed<unknown> {
  if (r.ok === 'skipped') return { status: 200, body: skippedBody };
  if (r.ok) return { status: 200, body: r.body };
  if ('rethrow' in r) {
    context.carry.rethrow = { cause: r.rethrow };
    throw r.rethrow;
  }
  throw new ORPCError('INTERNAL_SERVER_ERROR', { status: r.status, data: r.body, message: 'cron reply' });
}

/**
 * For `OpenAPIHandler`'s `customErrorResponseBodyEncoder`: an error's body is
 * exactly the reply body the policy gave, never oRPC's envelope.
 */
export const cronErrorBody = (error: ORPCError<string, unknown>): unknown => error.data;
