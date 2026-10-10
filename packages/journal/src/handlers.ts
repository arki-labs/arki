import type {
  AnyEntity,
  Db,
  Effect,
  EffectContext,
  EffectHandlers,
  Fn,
  Projection,
  ProjectionHandlers,
  Recorded,
} from './types.js';
import { assertStoredName } from './id.js';

type Erased<Meta, Args extends unknown[]> = Partial<
  Record<string, Fn<[...Args, event: Recorded<string, unknown, Meta>], unknown>>
>;

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

export function defineProjection<E extends AnyEntity<Meta>, Meta, Tx extends Db>(
  name: string,
  entity: E | readonly E[],
  on: NoInfer<ProjectionHandlers<E, Meta, Tx>>,
): Projection<Meta, Tx> {
  const handlers: Erased<Meta, [tx: Tx]> = on;
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

export function defineEffect<E extends AnyEntity<Meta>, Meta>(
  name: string,
  entity: E | readonly E[],
  on: NoInfer<EffectHandlers<E, Meta>>,
): Effect<Meta> {
  assertStoredName('effect name', name);
  const handlers: Partial<Record<string, Fn<[event: Recorded<string, unknown, Meta>, ctx: EffectContext], unknown>>> =
    on;
  return {
    name,
    entities: toList(entity),
    types: declaredTypes(handlers),
    async run(event, ctx) {
      const handler = ownHandler(handlers, event.type);
      // A job was queued for this type. Running nothing would acknowledge it silently.
      if (handler === undefined) throw new Error(`effect "${name}" has no handler for "${event.type}"`);
      await handler(event, ctx);
    },
  };
}
