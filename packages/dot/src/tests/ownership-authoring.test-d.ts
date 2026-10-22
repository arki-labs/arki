/** Guard regressions: exact outcomes and contextual async inference must survive every authoring form. */
import { expectTypeOf } from 'vitest';

import type { ScopePlan } from '@arki/async';
import type { Failure, FailureOf } from '@arki/failure';
import { child, cleanup, resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type { DotBootOutcome } from '../kernel/app-instance.js';
import type { Provided, UnitCloseFailure, UnitOpenFailure } from '../unit-contract.js';
import { defineFeature } from '../define-feature.js';
import { initUnits } from '../init-units.js';
import { infra, service } from '../unit-contract.js';

const Open = defineFailure('test.ownership_authoring.open');
const Close = defineFailure('test.ownership_authoring.close');
const Child = defineFailure('test.ownership_authoring.child');
const branch: () => boolean = () => false;
const open = () => (branch() ? Open() : { value: 1 });
const factories = { db: () => resource(open, () => Close()) };
const boot = () => ({ task: child(() => Child()), clean: cleanup(() => Close()) });
const _direct = infra({
  name: 'direct',
  needs: { count: service<number>() },
  provides: {
    db: ({ count }) =>
      resource(
        () => (branch() ? Open() : { value: count }),
        () => Close(),
      ),
  },
  boot({ db, count, $signal }) {
    expectTypeOf(db.value).toEqualTypeOf<number>();
    expectTypeOf(count).toEqualTypeOf<number>();
    expectTypeOf($signal).toEqualTypeOf<AbortSignal>();
    return boot();
  },
});
const keyed = initUnits.context<{ count: number; db: { value: number } }>().create();
const _keys = keyed.infra({
  name: 'keys',
  needs: ['count'],
  provides: {
    db: ({ count }) =>
      resource(
        () => (branch() ? Open() : { value: count }),
        () => Close(),
      ),
  },
  boot({ db, count }) {
    expectTypeOf(db.value).toEqualTypeOf<number>();
    expectTypeOf(count).toEqualTypeOf<number>();
    return boot();
  },
});
const _witness = keyed.infra({ name: 'witness', needs: { count: service<number>() }, provides: factories, boot });
const _chain = defineFeature('chain')
  .needs({ count: service<number>() })
  .usecases({ count: ({ count }: { readonly count: number }) => count })
  .provides({
    db: ({ usecases }) =>
      resource(
        () => (branch() ? Open() : { value: usecases.count }),
        () => Close(),
      ),
  })
  .entrypoints();
expectTypeOf<UnitOpenFailure<typeof _direct | typeof _keys | typeof _witness>>().toEqualTypeOf<
  FailureOf<typeof Open> | FailureOf<typeof Child>
>();
expectTypeOf<UnitCloseFailure<typeof _direct | typeof _keys | typeof _witness>>().toEqualTypeOf<
  FailureOf<typeof Close> | FailureOf<typeof Child>
>();
expectTypeOf<UnitOpenFailure<ReturnType<typeof _chain.units>[0]>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<UnitCloseFailure<ReturnType<typeof _chain.units>[0]>>().toEqualTypeOf<FailureOf<typeof Close>>();
expectTypeOf<Provided<typeof _chain.provides.db>>().toEqualTypeOf<{ value: number }>();
const unknownResource = () =>
  resource(
    (): unknown => Open(),
    () => void 0,
  );
const erased: ScopePlan = { db: resource(open, () => Close()) };
// @ts-expect-error unknown provider output cannot declare failures
infra({ name: 'bad', provides: { db: (): unknown => Open() } });
// @ts-expect-error unknown resource callback output cannot declare failures
infra({ name: 'bad', provides: { db: unknownResource } });
// @ts-expect-error unknown child output cannot declare failures
infra({ name: 'bad', boot: () => ({ child: child((): unknown => Child()) }) });
// @ts-expect-error unknown cleanup output cannot declare failures
infra({ name: 'bad', boot: () => ({ clean: cleanup((): unknown => Close()) }) });
// @ts-expect-error erased boot plan cannot declare failures
infra({ name: 'bad', boot: () => erased });
// @ts-expect-error unknown provider output cannot declare failures
keyed.infra({ name: 'bad', provides: { extra: (): unknown => Open() } });
// @ts-expect-error unknown resource callback output cannot declare failures
keyed.infra({ name: 'bad', provides: { extra: unknownResource } });
// @ts-expect-error unknown cleanup output cannot declare failures
keyed.infra({ name: 'bad', boot: () => ({ clean: cleanup((): unknown => Close()) }) });
// @ts-expect-error erased boot plan cannot declare failures
keyed.infra({ name: 'bad', boot: () => erased });
// @ts-expect-error unknown provider output cannot declare failures
keyed.infra({ name: 'bad', needs: { count: service<number>() }, provides: { extra: (): unknown => Open() } });
// @ts-expect-error erased boot plan cannot declare failures
keyed.infra({ name: 'bad', needs: { count: service<number>() }, boot: () => erased });
// @ts-expect-error unknown provider output cannot declare failures
defineFeature('bad').provides({ db: (): unknown => Open() });
// @ts-expect-error unknown resource callback output cannot declare failures
defineFeature('bad').provides({ db: unknownResource });
const genericBootFailure: Exclude<DotBootOutcome<Failure, Failure>, void> = Open();
expectTypeOf(genericBootFailure).toExtend<Failure>();
const erasedResource: ReturnType<typeof resource> = resource(
  (): unknown => open(),
  (_value: unknown): unknown => Close(),
);
const unknownClose = () => resource(open, (): unknown => Close());
// @ts-expect-error erased resource callback outcomes cannot declare failures
infra({ name: 'bad', provides: { db: () => erasedResource } });
// @ts-expect-error unknown resource cleanup output cannot declare failures
infra({ name: 'bad', provides: { db: unknownClose } });
// @ts-expect-error erased resource callback outcomes cannot declare failures
keyed.infra({ name: 'bad', provides: { extra: () => erasedResource } });
// @ts-expect-error unknown resource cleanup output cannot declare failures
keyed.infra({ name: 'bad', provides: { extra: unknownClose } });
// @ts-expect-error erased resource callback outcomes cannot declare failures
defineFeature('bad').provides({ db: () => erasedResource });
// @ts-expect-error unknown resource cleanup output cannot declare failures
defineFeature('bad').provides({ db: unknownClose });
const _plain = defineFeature('plain')
  .needs({ count: service<number>() })
  .usecases({ next: ({ count }: { readonly count: number }) => count + 1 })
  .provides({ next: ({ usecases }) => usecases.next })
  .entrypoints();
expectTypeOf<Provided<typeof _plain.provides.next>>().toEqualTypeOf<number>();
const createEntitlements = (db: { tag: string }) => ({
  source: db.tag,
  planOf: (id: string) => (id === 'pro' ? ('pro' as const) : ('free' as const)),
});
const _mixed = defineFeature('mixed')
  .needs({ db: service<{ tag: string }>() })
  .usecases({ entitlements: ({ db }) => createEntitlements(db) })
  .provides({
    entitlements: ({ usecases }) => usecases.entitlements,
    warmedAt: async () => {
      await Promise.resolve();
      return 42;
    },
  })
  .entrypoints();
expectTypeOf<Provided<typeof _mixed.provides.entitlements>>().toEqualTypeOf<ReturnType<typeof createEntitlements>>();
expectTypeOf<Provided<typeof _mixed.provides.warmedAt>>().toEqualTypeOf<number>();
const mixedUnit = infra({
  name: 'mixedUnit',
  needs: { db: service<{ tag: string }>() },
  provides: {
    entitlements: ({ db }) => createEntitlements(db),
    warmedAt: async () => {
      await Promise.resolve();
      return 42;
    },
  },
  boot({ entitlements, warmedAt }) {
    expectTypeOf(entitlements).toEqualTypeOf<ReturnType<typeof createEntitlements>>();
    expectTypeOf(warmedAt).toEqualTypeOf<number>();
  },
});
const mixedFactory = initUnits.context<{ db: { tag: string } }>().create();
const mixedKeys = mixedFactory.infra({
  name: 'mixedKeys',
  needs: ['db'],
  provides: {
    entitlements: ({ db }) => createEntitlements(db),
    warmedAt: async () => {
      await Promise.resolve();
      return 42;
    },
  },
  boot({ entitlements, warmedAt }) {
    expectTypeOf(entitlements).toEqualTypeOf<ReturnType<typeof createEntitlements>>();
    expectTypeOf(warmedAt).toEqualTypeOf<number>();
  },
});
const mixedWitness = mixedFactory.infra({
  name: 'mixedWitness',
  needs: { db: service<{ tag: string }>() },
  provides: {
    entitlements: ({ db }) => createEntitlements(db),
    warmedAt: async () => {
      await Promise.resolve();
      return 42;
    },
  },
  boot({ entitlements, warmedAt }) {
    expectTypeOf(entitlements).toEqualTypeOf<ReturnType<typeof createEntitlements>>();
    expectTypeOf(warmedAt).toEqualTypeOf<number>();
  },
});
void mixedUnit;
void mixedKeys;
void mixedWitness;
const asyncFactories = { acquired: async () => resource(open, () => Close()), _direct: async () => open() };
const _asyncUnit = infra({ name: 'asyncUnit', provides: asyncFactories });
const _asyncKeys = keyed.infra({ name: 'asyncKeys', provides: asyncFactories });
const _asyncWitness = keyed.infra({
  name: 'asyncWitness',
  needs: { count: service<number>() },
  provides: asyncFactories,
});
expectTypeOf<UnitOpenFailure<typeof _asyncUnit | typeof _asyncKeys | typeof _asyncWitness>>().toEqualTypeOf<
  FailureOf<typeof Open>
>();
expectTypeOf<UnitCloseFailure<typeof _asyncUnit | typeof _asyncKeys | typeof _asyncWitness>>().toEqualTypeOf<
  FailureOf<typeof Close>
>();
expectTypeOf<Provided<typeof _asyncUnit.provides.acquired>>().toEqualTypeOf<{ value: number }>();
expectTypeOf<Provided<typeof _asyncUnit.provides._direct>>().toEqualTypeOf<{ value: number }>();

// Structural service alternative must not accept promises that hide ownership outcomes.
// @ts-expect-error unknown async output
infra({ name: 'bad-async', provides: { db: async (): Promise<unknown> => Open() } });
// @ts-expect-error erased async resource output
infra({ name: 'bad-async', provides: { db: async () => erasedResource } });
// @ts-expect-error unknown async resource close output
infra({ name: 'bad-async', provides: { db: async () => unknownClose() } });
// @ts-expect-error cleanup descriptors cannot be provided asynchronously
infra({ name: 'bad-async', provides: { db: async () => cleanup(() => Close()) } });
// @ts-expect-error child descriptors cannot be provided asynchronously
infra({ name: 'bad-async', provides: { db: async () => child(() => Child()) } });
// @ts-expect-error unknown async output
keyed.infra({ name: 'bad-async', provides: { extra: async (): Promise<unknown> => Open() } });
// @ts-expect-error erased async resource output
keyed.infra({ name: 'bad-async', provides: { extra: async () => erasedResource } });
// @ts-expect-error unknown async resource close output
keyed.infra({ name: 'bad-async', provides: { extra: async () => unknownClose() } });
// @ts-expect-error cleanup descriptors cannot be provided asynchronously
keyed.infra({ name: 'bad-async', provides: { extra: async () => cleanup(() => Close()) } });
// @ts-expect-error child descriptors cannot be provided asynchronously
keyed.infra({ name: 'bad-async', provides: { extra: async () => child(() => Child()) } });
keyed.infra({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error unknown async output
  provides: { extra: async (): Promise<unknown> => Open() },
});
keyed.infra({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error erased async resource output
  provides: { extra: async () => erasedResource },
});
keyed.infra({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error unknown async resource close output
  provides: { extra: async () => unknownClose() },
});
keyed.infra({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error cleanup descriptors cannot be provided asynchronously
  provides: { extra: async () => cleanup(() => Close()) },
});
keyed.infra({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error child descriptors cannot be provided asynchronously
  provides: { extra: async () => child(() => Child()) },
});
// @ts-expect-error unknown async output
defineFeature('bad-async').provides({ db: async (): Promise<unknown> => Open() });
// @ts-expect-error erased async resource output
defineFeature('bad-async').provides({ db: async () => erasedResource });
// @ts-expect-error unknown async resource close output
defineFeature('bad-async').provides({ db: async () => unknownClose() });
// @ts-expect-error cleanup descriptors cannot be provided asynchronously
defineFeature('bad-async').provides({ db: async () => cleanup(() => Close()) });
// @ts-expect-error child descriptors cannot be provided asynchronously
defineFeature('bad-async').provides({ db: async () => child(() => Child()) });
const _asyncChain = defineFeature('_asyncChain').provides(asyncFactories).entrypoints();
expectTypeOf<UnitOpenFailure<ReturnType<typeof _asyncChain.units>[0]>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<UnitCloseFailure<ReturnType<typeof _asyncChain.units>[0]>>().toEqualTypeOf<FailureOf<typeof Close>>();
expectTypeOf<Provided<typeof _asyncChain.provides.acquired>>().toEqualTypeOf<{ value: number }>();
expectTypeOf<Provided<typeof _asyncChain.provides._direct>>().toEqualTypeOf<{ value: number }>();

// Generic adapters must admit known service shapes without losing their resolved values.
function genericRecord<Value extends Record<string, string>>(value: Value) {
  const factory = initUnits.context<{ count: number }>().create();
  const provides = { value: () => value, asyncValue: async () => value };
  return {
    plugin: infra({ name: 'record', provides }).provides,
    keys: factory.infra({ name: 'record', provides }).provides,
    witness: factory.infra({ name: 'record', needs: factory.needs('count'), provides }).provides,
    chain: defineFeature('record').provides(provides).entrypoints().provides,
  };
}
function genericScalar<Value extends string>(value: Value) {
  const factory = initUnits.context<{ count: number }>().create();
  const provides = { value: () => value, asyncValue: async () => value };
  return {
    plugin: infra({ name: 'scalar', provides }).provides,
    keys: factory.infra({ name: 'scalar', provides }).provides,
    witness: factory.infra({ name: 'scalar', needs: factory.needs('count'), provides }).provides,
    chain: defineFeature('scalar').provides(provides).entrypoints().provides,
  };
}
const recordValue = { label: 'known' };
const _recordProviders = genericRecord(recordValue);
const scalarValue = 'known';
const _scalarProviders = genericScalar(scalarValue);
type ResolvedProviders<Providers> = {
  [Kind in keyof Providers]: { [Name in keyof Providers[Kind]]: Provided<Providers[Kind][Name]> };
};
type ExpectedProviders<Providers, Value> = {
  [Kind in keyof Providers]: { [Name in keyof Providers[Kind]]: Value };
};
expectTypeOf<ResolvedProviders<typeof _recordProviders>>().toEqualTypeOf<
  ExpectedProviders<typeof _recordProviders, typeof recordValue>
>();
expectTypeOf<ResolvedProviders<typeof _scalarProviders>>().toEqualTypeOf<
  ExpectedProviders<typeof _scalarProviders, typeof scalarValue>
>();
