/** Guard regressions: exact outcomes and contextual async inference must survive every authoring form. */
import { expectTypeOf } from 'vitest';

import type { ScopePlan } from '@arki/async';
import type { Failure, FailureOf } from '@arki/failure';
import { child, cleanup, resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type { AnyFeature } from '../feature.js';
import type { DotBootOutcome } from '../kernel/app-instance.js';
import type { PluginCloseFailure, PluginOpenFailure, Provided } from '../plugin-contract.js';
import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';
import { feature, plug } from '../feature.js';
import { initPlugins } from '../init-plugins.js';
import { plugin, service } from '../plugin-contract.js';

const Open = defineFailure('test.ownership_authoring.open');
const Close = defineFailure('test.ownership_authoring.close');
const Child = defineFailure('test.ownership_authoring.child');
const branch: () => boolean = () => false;
const open = () => (branch() ? Open() : { value: 1 });
const factories = { db: () => resource(open, () => Close()) };
const boot = () => ({ task: child(() => Child()), clean: cleanup(() => Close()) });
const _direct = plugin({
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
const keyed = initPlugins.context<{ count: number; db: { value: number } }>().create();
const _keys = keyed.plugin({
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
const _witness = keyed.plugin({ name: 'witness', needs: { count: service<number>() }, provides: factories, boot });
const object = feature('object', {
  needs: { count: service<number>() },
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
const _objectPlugin = plug(object);
const _chain = defineFeature('chain')
  .needs({ count: service<number>() })
  .provides({
    db: ({ count }) =>
      resource(
        () => (branch() ? Open() : { value: count }),
        () => Close(),
      ),
  })
  .entrypoints();
expectTypeOf<PluginOpenFailure<typeof _direct | typeof _keys | typeof _witness | typeof _objectPlugin>>().toEqualTypeOf<
  FailureOf<typeof Open> | FailureOf<typeof Child>
>();
expectTypeOf<
  PluginCloseFailure<typeof _direct | typeof _keys | typeof _witness | typeof _objectPlugin>
>().toEqualTypeOf<FailureOf<typeof Close> | FailureOf<typeof Child>>();
expectTypeOf<PluginOpenFailure<ReturnType<typeof _chain.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<PluginCloseFailure<ReturnType<typeof _chain.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof Close>>();
expectTypeOf<Provided<typeof object.provides.db>>().toEqualTypeOf<{ value: number }>();
const unknownResource = () =>
  resource(
    (): unknown => Open(),
    () => void 0,
  );
const erased: ScopePlan = { db: resource(open, () => Close()) };
// @ts-expect-error unknown provider output cannot declare failures
plugin({ name: 'bad', provides: { db: (): unknown => Open() } });
// @ts-expect-error unknown resource callback output cannot declare failures
plugin({ name: 'bad', provides: { db: unknownResource } });
// @ts-expect-error unknown child output cannot declare failures
plugin({ name: 'bad', boot: () => ({ child: child((): unknown => Child()) }) });
// @ts-expect-error unknown cleanup output cannot declare failures
plugin({ name: 'bad', boot: () => ({ clean: cleanup((): unknown => Close()) }) });
// @ts-expect-error erased boot plan cannot declare failures
plugin({ name: 'bad', boot: () => erased });
// @ts-expect-error unknown provider output cannot declare failures
keyed.plugin({ name: 'bad', provides: { extra: (): unknown => Open() } });
// @ts-expect-error unknown resource callback output cannot declare failures
keyed.plugin({ name: 'bad', provides: { extra: unknownResource } });
// @ts-expect-error unknown cleanup output cannot declare failures
keyed.plugin({ name: 'bad', boot: () => ({ clean: cleanup((): unknown => Close()) }) });
// @ts-expect-error erased boot plan cannot declare failures
keyed.plugin({ name: 'bad', boot: () => erased });
// @ts-expect-error unknown provider output cannot declare failures
keyed.plugin({ name: 'bad', needs: { count: service<number>() }, provides: { extra: (): unknown => Open() } });
// @ts-expect-error erased boot plan cannot declare failures
keyed.plugin({ name: 'bad', needs: { count: service<number>() }, boot: () => erased });
// @ts-expect-error unknown provider output cannot declare failures
feature('bad', { provides: { db: (): unknown => Open() } });
// @ts-expect-error unknown resource callback output cannot declare failures
feature('bad', { provides: { db: unknownResource } });
// @ts-expect-error unknown cleanup output cannot declare failures
feature('bad', { boot: () => ({ clean: cleanup((): unknown => Close()) }) });
// @ts-expect-error erased boot plan cannot declare failures
feature('bad', { boot: () => erased });
// @ts-expect-error unknown provider output cannot declare failures
defineFeature('bad').provides({ db: (): unknown => Open() });
// @ts-expect-error unknown resource callback output cannot declare failures
defineFeature('bad').provides({ db: unknownResource });
const erasedFeature: AnyFeature = feature('erased', { provides: factories, boot });
const _erasedApp = defineApp('erased').features([erasedFeature]);
const genericBootFailure: Exclude<DotBootOutcome<Failure, Failure>, void> = Open();
const erasedAppFailure: FailureOf<typeof _erasedApp.boot> = Open();
expectTypeOf(genericBootFailure).toExtend<Failure>();
expectTypeOf(erasedAppFailure).toExtend<Failure>();
const erasedResource: ReturnType<typeof resource> = resource(
  (): unknown => open(),
  (_value: unknown): unknown => Close(),
);
const unknownClose = () => resource(open, (): unknown => Close());
// @ts-expect-error erased resource callback outcomes cannot declare failures
plugin({ name: 'bad', provides: { db: () => erasedResource } });
// @ts-expect-error unknown resource cleanup output cannot declare failures
plugin({ name: 'bad', provides: { db: unknownClose } });
// @ts-expect-error erased resource callback outcomes cannot declare failures
keyed.plugin({ name: 'bad', provides: { extra: () => erasedResource } });
// @ts-expect-error unknown resource cleanup output cannot declare failures
keyed.plugin({ name: 'bad', provides: { extra: unknownClose } });
// @ts-expect-error erased resource callback outcomes cannot declare failures
feature('bad', { provides: { db: () => erasedResource } });
// @ts-expect-error unknown resource cleanup output cannot declare failures
feature('bad', { provides: { db: unknownClose } });
// @ts-expect-error erased resource callback outcomes cannot declare failures
defineFeature('bad').provides({ db: () => erasedResource });
// @ts-expect-error unknown resource cleanup output cannot declare failures
defineFeature('bad').provides({ db: unknownClose });
const _plain = feature('plain', {
  needs: { count: service<number>() },
  provides: { next: ({ count }) => count + 1 },
  boot({ next, count }) {
    expectTypeOf(next).toEqualTypeOf<number>();
    expectTypeOf(count).toEqualTypeOf<number>();
  },
});
expectTypeOf<Provided<typeof _plain.provides.next>>().toEqualTypeOf<number>();
const erasedCloseAppFailure: FailureOf<
  Extract<Awaited<ReturnType<typeof _erasedApp.boot>>, { dispose: unknown }>['dispose']
> = Close();
const erasedStartFailure: FailureOf<typeof _erasedApp.start> = Open();
expectTypeOf(erasedCloseAppFailure).toExtend<Failure>();
expectTypeOf(erasedStartFailure).toExtend<Failure>();
const createEntitlements = (db: { tag: string }) => ({
  source: db.tag,
  planOf: (id: string) => (id === 'pro' ? ('pro' as const) : ('free' as const)),
});
const _mixed = feature('mixed', {
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
expectTypeOf<Provided<typeof _mixed.provides.entitlements>>().toEqualTypeOf<ReturnType<typeof createEntitlements>>();
expectTypeOf<Provided<typeof _mixed.provides.warmedAt>>().toEqualTypeOf<number>();
const mixedPlugin = plugin({
  name: 'mixedPlugin',
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
const mixedFactory = initPlugins.context<{ db: { tag: string } }>().create();
const mixedKeys = mixedFactory.plugin({
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
const mixedWitness = mixedFactory.plugin({
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
void mixedPlugin;
void mixedKeys;
void mixedWitness;
const asyncFactories = { acquired: async () => resource(open, () => Close()), _direct: async () => open() };
const _asyncPlugin = plugin({ name: 'asyncPlugin', provides: asyncFactories });
const _asyncObject = plug(feature('asyncObject', { provides: asyncFactories }));
const _asyncKeys = keyed.plugin({ name: 'asyncKeys', provides: asyncFactories });
const _asyncWitness = keyed.plugin({
  name: 'asyncWitness',
  needs: { count: service<number>() },
  provides: asyncFactories,
});
expectTypeOf<
  PluginOpenFailure<typeof _asyncPlugin | typeof _asyncObject | typeof _asyncKeys | typeof _asyncWitness>
>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<
  PluginCloseFailure<typeof _asyncPlugin | typeof _asyncObject | typeof _asyncKeys | typeof _asyncWitness>
>().toEqualTypeOf<FailureOf<typeof Close>>();
expectTypeOf<Provided<typeof _asyncPlugin.provides.acquired>>().toEqualTypeOf<{ value: number }>();
expectTypeOf<Provided<typeof _asyncPlugin.provides._direct>>().toEqualTypeOf<{ value: number }>();

// Structural service alternative must not accept promises that hide ownership outcomes.
// @ts-expect-error unknown async output
plugin({ name: 'bad-async', provides: { db: async (): Promise<unknown> => Open() } });
// @ts-expect-error erased async resource output
plugin({ name: 'bad-async', provides: { db: async () => erasedResource } });
// @ts-expect-error unknown async resource close output
plugin({ name: 'bad-async', provides: { db: async () => unknownClose() } });
// @ts-expect-error cleanup descriptors cannot be provided asynchronously
plugin({ name: 'bad-async', provides: { db: async () => cleanup(() => Close()) } });
// @ts-expect-error child descriptors cannot be provided asynchronously
plugin({ name: 'bad-async', provides: { db: async () => child(() => Child()) } });
// @ts-expect-error unknown async output
keyed.plugin({ name: 'bad-async', provides: { extra: async (): Promise<unknown> => Open() } });
// @ts-expect-error erased async resource output
keyed.plugin({ name: 'bad-async', provides: { extra: async () => erasedResource } });
// @ts-expect-error unknown async resource close output
keyed.plugin({ name: 'bad-async', provides: { extra: async () => unknownClose() } });
// @ts-expect-error cleanup descriptors cannot be provided asynchronously
keyed.plugin({ name: 'bad-async', provides: { extra: async () => cleanup(() => Close()) } });
// @ts-expect-error child descriptors cannot be provided asynchronously
keyed.plugin({ name: 'bad-async', provides: { extra: async () => child(() => Child()) } });
keyed.plugin({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error unknown async output
  provides: { extra: async (): Promise<unknown> => Open() },
});
keyed.plugin({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error erased async resource output
  provides: { extra: async () => erasedResource },
});
keyed.plugin({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error unknown async resource close output
  provides: { extra: async () => unknownClose() },
});
keyed.plugin({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error cleanup descriptors cannot be provided asynchronously
  provides: { extra: async () => cleanup(() => Close()) },
});
keyed.plugin({
  name: 'bad-async',
  needs: { count: service<number>() },
  // @ts-expect-error child descriptors cannot be provided asynchronously
  provides: { extra: async () => child(() => Child()) },
});
// @ts-expect-error unknown async output
feature('bad-async', { provides: { db: async (): Promise<unknown> => Open() } });
// @ts-expect-error erased async resource output
feature('bad-async', { provides: { db: async () => erasedResource } });
// @ts-expect-error unknown async resource close output
feature('bad-async', { provides: { db: async () => unknownClose() } });
// @ts-expect-error cleanup descriptors cannot be provided asynchronously
feature('bad-async', { provides: { db: async () => cleanup(() => Close()) } });
// @ts-expect-error child descriptors cannot be provided asynchronously
feature('bad-async', { provides: { db: async () => child(() => Child()) } });
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
expectTypeOf<PluginOpenFailure<ReturnType<typeof _asyncChain.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof Open>>();
expectTypeOf<PluginCloseFailure<ReturnType<typeof _asyncChain.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof Close>>();
expectTypeOf<Provided<typeof _asyncChain.provides.acquired>>().toEqualTypeOf<{ value: number }>();
expectTypeOf<Provided<typeof _asyncChain.provides._direct>>().toEqualTypeOf<{ value: number }>();

// Generic adapters must admit known service shapes without losing their resolved values.
function genericRecord<Value extends Record<string, string>>(value: Value) {
  const factory = initPlugins.context<{ count: number }>().create();
  const provides = { value: () => value, asyncValue: async () => value };
  return {
    plugin: plugin({ name: 'record', provides }).provides,
    feature: feature('record', { provides }).provides,
    keys: factory.plugin({ name: 'record', provides }).provides,
    witness: factory.plugin({ name: 'record', needs: factory.needs('count'), provides }).provides,
    chain: defineFeature('record').provides(provides).entrypoints().provides,
  };
}
function genericScalar<Value extends string>(value: Value) {
  const factory = initPlugins.context<{ count: number }>().create();
  const provides = { value: () => value, asyncValue: async () => value };
  return {
    plugin: plugin({ name: 'scalar', provides }).provides,
    feature: feature('scalar', { provides }).provides,
    keys: factory.plugin({ name: 'scalar', provides }).provides,
    witness: factory.plugin({ name: 'scalar', needs: factory.needs('count'), provides }).provides,
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
