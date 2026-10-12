import type {
  AnyEntity,
  BivariantFn,
  DbHandle,
  Effect,
  EffectContext,
  EffectHandlers,
  Projection,
  ProjectionHandlers,
  Recorded,
} from './types.js';
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
): Projection<Meta, Tx> {
  const handlers: Partial<Record<string, BivariantFn<[tx: Tx, event: Recorded<string, unknown, Meta>], unknown>>> = on;
  return {
    name,
    entities: toList(entity),
    types: declaredTypes(handlers),
    async run(tx, event) {
      const handler = ownHandler(handlers, event.type);
      if (handler !== undefined) await handler(tx, event);
    },
  };
}

export function defineEffect<E extends AnyEntity<Meta>, Meta, AppDb>(
  name: string,
  entity: E | readonly E[],
  on: NoInfer<EffectHandlers<E, Meta, AppDb>>,
): Effect<Meta, AppDb> {
  assertStoredName('effect name', name);
  const handlers: Partial<
    Record<string, BivariantFn<[event: Recorded<string, unknown, Meta>, ctx: EffectContext<AppDb>], unknown>>
  > = on;
  return {
    name,
    entities: toList(entity),
    types: declaredTypes(handlers),
    async run(event, ctx) {
      const handler = ownHandler(handlers, event.type);
      // A job was queued for this type. Running nothing would acknowledge it silently.
      if (handler === undefined)
        throw new Error(
          `effect "${name}" has no handler for "${event.type}", but a job was queued for it; add a handler for this event to the effect, or delete the job if the event is no longer handled`,
        );
      await handler(event, ctx);
    },
  };
}
