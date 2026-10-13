import type {
  AnyEntity,
  BivariantFn,
  DbHandle,
  Effect,
  EffectContext,
  EffectHandlers,
  EffectSchedule,
  Need,
  Needed,
  Needs,
  Projection,
  ProjectionHandlers,
  ProjectionOptions,
  Recorded,
  Services,
  Tap,
  TapContext,
  TapHandlers,
} from './types.js';
import { JournalError } from './errors.js';
import { assertStoredName } from './id.js';

/** An entity has a `kind`; an array of entities does not. */
function toList<E extends { readonly kind: string }>(entity: E | readonly E[]): readonly E[] {
  return 'kind' in entity ? [entity] : entity;
}

/**
 * Only an own property counts as a handler. A plain object inherits `toString`,
 * `constructor` and friends from `Object.prototype`; an event type with one of
 * those names must not find a handler nobody declared.
 */
function ownHandler<H>(handlers: Partial<Record<string, H>>, type: string): H | undefined {
  return Object.hasOwn(handlers, type) ? handlers[type] : undefined;
}

function declaredTypes(handlers: Partial<Record<string, unknown>>): ReadonlySet<string> {
  return new Set(Object.keys(handlers).filter(key => ownHandler(handlers, key) !== undefined));
}

export function defineProjection<E extends AnyEntity<Meta>, Meta, Tx extends DbHandle>(
  name: string,
  entity: E | readonly E[],
  on: NoInfer<ProjectionHandlers<E, Meta, Tx>>,
  opts?: ProjectionOptions,
): Projection<Meta, Tx> {
  const handlers: Partial<Record<string, BivariantFn<[tx: Tx, event: Recorded<string, unknown, Meta>], unknown>>> = on;
  if (opts?.lane === 'async') assertStoredName('effect name', name);
  return {
    name,
    entities: toList(entity),
    types: declaredTypes(handlers),
    lane: opts?.lane ?? 'inline',
    async run(tx, event) {
      const handler = ownHandler(handlers, event.type);
      if (handler !== undefined) await handler(tx, event);
    },
  };
}

/** Every effect handler gets these. A need must not take one of their names. */
const builtInContext = new Set(['jobId', 'signal', 'db', 'run']);

/** Declare one thing an effect needs: `j.effect('order-mail', order, { mailer: need<Mailer>() }, { ... })`. */
export const need = <T>(): Need<T> => ({});

function defineEffect<E extends AnyEntity<Meta>, Meta, AppDb, Run, N extends Needs>(
  name: string,
  entity: E | readonly E[],
  needs: N,
  on: EffectHandlers<E, Meta, AppDb, Run, N>,
): Effect<Meta, AppDb, Run, N> {
  assertStoredName('effect name', name);
  for (const key of Object.keys(needs)) {
    if (builtInContext.has(key))
      throw new JournalError(
        'BAD_DEFINITION',
        'effect',
        name,
        `journal: effect "${name}" has a need named "${key}", but the handler context already has "jobId", "signal", "db" and "run"; give the need another name`,
      );
  }
  const handlers: Partial<
    Record<
      string,
      BivariantFn<[event: Recorded<string, unknown, Meta>, ctx: EffectContext<AppDb, Run> & Needed<N>], unknown>
    >
  > = on;
  return withSchedule(
    {
      name,
      entities: toList(entity),
      types: declaredTypes(handlers),
      needs,
      async run(event, ctx) {
        const handler = ownHandler(handlers, event.type);
        // A job was queued for this type. Running nothing would acknowledge it silently.
        if (handler === undefined)
          throw new Error(
            `effect "${name}" has no handler for "${event.type}", but a job was queued for it; add a handler for this event to the effect, or delete the job if the event is no longer handled`,
          );
        await handler(event, ctx);
      },
    },
    {},
  );
}

const INT4_MAX = 2_147_483_647;

/** Attach a schedule to an effect, checked once: a job row must be able to hold it. */
export function withSchedule<Meta, AppDb, Run, N extends Needs>(
  effect: Omit<Effect<Meta, AppDb, Run, N>, 'schedule' | 'withSchedule'>,
  schedule: EffectSchedule<Meta>,
): Effect<Meta, AppDb, Run, N> {
  const { priority = 0, delaySeconds = 0 } = schedule;
  if (!Number.isInteger(priority) || Math.abs(priority) > INT4_MAX)
    throw new JournalError(
      'BAD_DEFINITION',
      'effect',
      effect.name,
      `journal: effect "${effect.name}": priority must be an integer within 32 bits, got ${String(priority)}`,
    );
  if (!Number.isFinite(delaySeconds) || delaySeconds < 0)
    throw new JournalError(
      'BAD_DEFINITION',
      'effect',
      effect.name,
      `journal: effect "${effect.name}": delaySeconds must be a finite number of seconds, zero or more, got ${String(delaySeconds)}`,
    );
  if (schedule.delaySeconds !== undefined && schedule.runAt !== undefined)
    throw new JournalError(
      'BAD_DEFINITION',
      'effect',
      effect.name,
      `journal: effect "${effect.name}": give delaySeconds or runAt, not both`,
    );
  return {
    ...effect,
    schedule,
    withSchedule: next => withSchedule(effect, next),
  };
}

/** `j.effect` for one journal. Three arguments: the effect needs nothing. Four: the third lists its needs. */
export function effectFor<Meta, AppDb, Run>() {
  function effect<E extends AnyEntity<Meta>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<EffectHandlers<E, Meta, AppDb, Run>>,
  ): Effect<Meta, AppDb, Run>;
  function effect<E extends AnyEntity<Meta>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    needs: N,
    on: NoInfer<EffectHandlers<E, Meta, AppDb, Run, N>>,
  ): Effect<Meta, AppDb, Run, N>;
  function effect<E extends AnyEntity<Meta>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    ...rest: [on: EffectHandlers<E, Meta, AppDb, Run>] | [needs: N, on: EffectHandlers<E, Meta, AppDb, Run, N>]
  ) {
    return rest.length === 1 ? defineEffect(name, entity, {}, rest[0]) : defineEffect(name, entity, rest[0], rest[1]);
  }
  return effect;
}

function defineTap<E extends AnyEntity<Meta>, Meta, AppDb, N extends Needs>(
  name: string,
  entity: E | readonly E[],
  needs: N,
  on: TapHandlers<E, Meta, AppDb, N>,
): Tap<Meta, AppDb, N> {
  assertStoredName('effect name', name);
  if (Object.hasOwn(needs, 'db'))
    throw new JournalError(
      'BAD_DEFINITION',
      'tap',
      name,
      `journal: tap "${name}" has a need named "db", but the handler context already has "db"; give the need another name`,
    );
  const handlers: Partial<
    Record<string, BivariantFn<[event: Recorded<string, unknown, Meta>, ctx: TapContext<AppDb> & Needed<N>], unknown>>
  > = on;
  return {
    name,
    entities: toList(entity),
    types: declaredTypes(handlers),
    needs,
    async run(event, ctx) {
      await ownHandler(handlers, event.type)?.(event, ctx);
    },
  };
}

/** `j.tap` for one journal. Three arguments: the tap needs nothing. Four: the third lists its needs. */
export function tapFor<Meta, AppDb>() {
  function tap<E extends AnyEntity<Meta>>(
    name: string,
    entity: E | readonly E[],
    on: NoInfer<TapHandlers<E, Meta, AppDb>>,
  ): Tap<Meta, AppDb>;
  function tap<E extends AnyEntity<Meta>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    needs: N,
    on: NoInfer<TapHandlers<E, Meta, AppDb, N>>,
  ): Tap<Meta, AppDb, N>;
  function tap<E extends AnyEntity<Meta>, N extends Needs>(
    name: string,
    entity: E | readonly E[],
    ...rest: [on: TapHandlers<E, Meta, AppDb>] | [needs: N, on: TapHandlers<E, Meta, AppDb, N>]
  ) {
    return rest.length === 1 ? defineTap(name, entity, {}, rest[0]) : defineTap(name, entity, rest[0], rest[1]);
  }
  return tap;
}

/** Give one tap its services, as `bindEffect` does for an effect. */
export function bindTap<Meta, AppDb>(tap: Tap<Meta, AppDb, Needs>, services: Services): Tap<Meta, AppDb> {
  const given: Record<string, unknown> = {};
  for (const key of Object.keys(tap.needs)) {
    if (!Object.hasOwn(services, key) || services[key] === undefined)
      throw new JournalError(
        'BAD_DEFINITION',
        'tap',
        tap.name,
        `journal: tap "${tap.name}" needs "${key}", but no service with that name was given; pass it as j.compose({ services: { ${key} } }), or in a Dot app add it to the \`needs\` of the feature that lists this tap`,
      );
    given[key] = services[key];
  }
  return { ...tap, needs: {}, run: (event, ctx) => tap.run(event, { ...given, ...ctx }) };
}

/**
 * Give one effect its services. The result needs nothing more, so the worker can run it.
 * `services` may hold more than this effect needs: each need is read by its name.
 * This is the only place a need meets its value. `j.compose` calls it with the app's
 * `services`; the Dot bridge calls it with the services of the feature that lists the effect.
 */
export function bindEffect<Meta, AppDb, Run>(
  effect: Effect<Meta, AppDb, Run, Needs>,
  services: Services,
): Effect<Meta, AppDb, Run> {
  const given: Record<string, unknown> = {};
  for (const key of Object.keys(effect.needs)) {
    // Without this check the effect would start, and every job would fail on `undefined`.
    if (!Object.hasOwn(services, key) || services[key] === undefined)
      throw new JournalError(
        'BAD_DEFINITION',
        'effect',
        effect.name,
        `journal: effect "${effect.name}" needs "${key}", but no service with that name was given; pass it as j.compose({ services: { ${key} } }), or in a Dot app add it to the \`needs\` of the feature that lists this effect`,
      );
    given[key] = services[key];
  }
  return withSchedule(
    { ...effect, needs: {}, run: (event, ctx) => effect.run(event, { ...given, ...ctx }) },
    effect.schedule,
  );
}
