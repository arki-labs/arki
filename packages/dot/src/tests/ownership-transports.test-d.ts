/** Ownership callbacks remain visible through every authoring and mount form. */
import { expectTypeOf } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { child, cleanup, resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type { PluginCloseFailure, PluginOpenFailure, PluginProvides, Provided } from '../plugin-contract.js';
import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';
import { bindDriver, driven, driver, feature, plug } from '../feature.js';
import { initPlugins } from '../init-plugins.js';
import { lazy } from '../lazy.js';
import { plugin, rename, service } from '../plugin-contract.js';

const OpenRefused = defineFailure('ownership.transport.open');
const CloseRefused = defineFailure('ownership.transport.close');
const ChildRefused = defineFailure('ownership.transport.child');
const possible = (): boolean => false;
const open = () => (possible() ? OpenRefused() : { query: () => 42 });
const close = (value: SuccessOf<typeof open>) => (possible() ? CloseRefused() : void value.query());
const watch = () => (possible() ? ChildRefused() : undefined);
const flush = () => (possible() ? CloseRefused() : undefined);
const factories = { db: () => resource(open, close) };
const boot = () => ({ watch: child(watch), flush: cleanup(flush) });
const direct = plugin({ name: 'direct', provides: factories, boot });
const objectFeature = feature('object', { provides: factories, boot });
const _mountedObject = plug(objectFeature);
const _renamed = rename(direct, { db: 'renamedDb' });
const driving = driver(() => direct);
const _drivingBound = bindDriver(driving, []);
const _drivenBound = driven(() => direct).bind([]);
const factory = initPlugins.context<{ count: number; db: SuccessOf<typeof open> }>().create();
const byKeys = factory.plugin({ name: 'keys', needs: ['count'], provides: factories, boot });
const _byWitness = factory.plugin({ name: 'witness', needs: { count: service<number>() }, provides: factories, boot });
const chain = defineFeature('chain').provides(factories).entrypoints();
const childFeature = defineFeature('parent.child').provides(factories).entrypoints();
const parent = defineFeature('parent').features(childFeature).entrypoints();
const _withInfra = defineFeature('infra').infra(direct).entrypoints();
const instanced = chain.instance('copy');
const lazyHandle = lazy(open, { dispose: close });
const _lazyPlugin = plugin({ name: 'lazy', provides: { db: () => lazyHandle } });
const _lazyFeature = feature('lazy-feature', { provides: { db: () => lazyHandle } });
const _chainLazy = defineFeature('chain-lazy')
  .provides({ db: () => lazyHandle })
  .entrypoints();

type OpenOfDirect = PluginOpenFailure<typeof direct>;
type CloseOfDirect = PluginCloseFailure<typeof direct>;
type OwnedForms =
  | typeof _mountedObject
  | typeof _renamed
  | (readonly [typeof _drivingBound, typeof _drivenBound])[number]
  | typeof byKeys
  | typeof _byWitness;
// Object keeps both phases exact.
expectTypeOf<PluginOpenFailure<typeof _mountedObject>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<PluginCloseFailure<typeof _mountedObject>>().toEqualTypeOf<CloseOfDirect>();
// Renamed keeps both phases exact.
expectTypeOf<PluginOpenFailure<typeof _renamed>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<PluginCloseFailure<typeof _renamed>>().toEqualTypeOf<CloseOfDirect>();
// Driver keeps both phases exact.
expectTypeOf<PluginOpenFailure<typeof _drivingBound>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<PluginCloseFailure<typeof _drivingBound>>().toEqualTypeOf<CloseOfDirect>();
// Driven keeps both phases exact.
expectTypeOf<PluginOpenFailure<typeof _drivenBound>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<PluginCloseFailure<typeof _drivenBound>>().toEqualTypeOf<CloseOfDirect>();
// Keys keeps both phases exact.
expectTypeOf<PluginOpenFailure<typeof byKeys>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<PluginCloseFailure<typeof byKeys>>().toEqualTypeOf<CloseOfDirect>();
// Witness keeps both phases exact.
expectTypeOf<PluginOpenFailure<typeof _byWitness>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<PluginCloseFailure<typeof _byWitness>>().toEqualTypeOf<CloseOfDirect>();
// ObjectService
expectTypeOf<Provided<typeof objectFeature.provides.db>>().toEqualTypeOf<SuccessOf<typeof open>>();
// MountedService
expectTypeOf<PluginProvides<typeof _mountedObject>['db']>().toEqualTypeOf<SuccessOf<typeof open>>();
// ChainService
expectTypeOf<Provided<typeof chain.provides.db>>().toEqualTypeOf<SuccessOf<typeof open>>();
// ChainOpen
expectTypeOf<PluginOpenFailure<ReturnType<typeof chain.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof open>>();
// ChainClose
expectTypeOf<PluginCloseFailure<ReturnType<typeof chain.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof close>>();
// NestedOpen
expectTypeOf<PluginOpenFailure<ReturnType<typeof parent.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof open>>();
// NestedClose
expectTypeOf<PluginCloseFailure<ReturnType<typeof parent.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof close>>();
// InfraOpen
expectTypeOf<PluginOpenFailure<ReturnType<typeof _withInfra.plugins>[0]>>().toEqualTypeOf<OpenOfDirect>();
// InfraClose
expectTypeOf<PluginCloseFailure<ReturnType<typeof _withInfra.plugins>[0]>>().toEqualTypeOf<CloseOfDirect>();
// InstanceOpen
expectTypeOf<PluginOpenFailure<ReturnType<typeof instanced.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof open>>();
// InstanceClose
expectTypeOf<PluginCloseFailure<ReturnType<typeof instanced.plugins>[0]>>().toEqualTypeOf<FailureOf<typeof close>>();
// LazyObjectClose
expectTypeOf<PluginCloseFailure<ReturnType<typeof plug<typeof _lazyFeature>>>>().toEqualTypeOf<
  PluginCloseFailure<typeof _lazyPlugin>
>();
// LazyChainClose
expectTypeOf<PluginCloseFailure<ReturnType<typeof _chainLazy.plugins>[0]>>().toEqualTypeOf<
  PluginCloseFailure<typeof _lazyPlugin>
>();
// NoBareFailure
expectTypeOf<string extends PluginCloseFailure<OwnedForms>['code'] ? true : false>().toEqualTypeOf<false>();

const _directApp = defineApp('direct').use(direct);
const _objectApp = defineApp('object').features([objectFeature]);
const _drivingApp = defineApp('driver').features([]).serve(driving);
const _drivenApp = defineApp('driven')
  .use(driven(() => direct))
  .features([]);
const _allApp = defineApp('all').useAll([direct]);
const _infraApp = defineApp('infra').infra(direct);
const _entrypointApp = defineApp('entrypoint').features([]).entrypoints(driving);
const directResource = plugin({ name: 'resource', provides: factories });
const _resourceApp = defineApp('resource').use(directResource);
const _chainApp = defineApp('chain').features([chain]);
const _nestedApp = defineApp('parent').features([parent]);
const _instanceApp = defineApp('instance').features([instanced]);
expectTypeOf<FailureOf<typeof _objectApp.boot>>().toEqualTypeOf<FailureOf<typeof _directApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _objectApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _drivingApp.boot>>().toEqualTypeOf<FailureOf<typeof _directApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _drivingApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _drivenApp.boot>>().toEqualTypeOf<FailureOf<typeof _directApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _drivenApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _allApp.boot>>().toEqualTypeOf<FailureOf<typeof _directApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _allApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _infraApp.boot>>().toEqualTypeOf<FailureOf<typeof _directApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _infraApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _entrypointApp.boot>>().toEqualTypeOf<FailureOf<typeof _directApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _entrypointApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _directApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _chainApp.boot>>().toEqualTypeOf<FailureOf<typeof _resourceApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _chainApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _resourceApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _nestedApp.boot>>().toEqualTypeOf<FailureOf<typeof _resourceApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _nestedApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _resourceApp.boot>['dispose']>
>();
expectTypeOf<FailureOf<typeof _instanceApp.boot>>().toEqualTypeOf<FailureOf<typeof _resourceApp.boot>>();
expectTypeOf<FailureOf<SuccessOf<typeof _instanceApp.boot>['dispose']>>().toEqualTypeOf<
  FailureOf<SuccessOf<typeof _resourceApp.boot>['dispose']>
>();
export function consumers(value: PluginProvides<typeof _mountedObject>['db']) {
  const database = defineApp('object').features([objectFeature]);
  const adapters = defineApp('adapters')
    .use(plugin({ name: 'count', provides: { count: () => 1 } }))
    .use(byKeys);
  void database;
  void adapters;
  // @ts-expect-error A resource descriptor must never reach the service consumer.
  value.prepare(new AbortController().signal);
  // @ts-expect-error A boot callback only returns a supported scope plan, void or a declared failure.
  feature('invalid-boot', { boot: () => ({ arbitrary: true }) });
  // @ts-expect-error Published success must match the context schema, even when acquired through a resource.
  factory.plugin({
    name: 'invalid-service',
    provides: {
      count: () =>
        resource(
          () => 'wrong',
          () => void 0,
        ),
    },
  });
}
