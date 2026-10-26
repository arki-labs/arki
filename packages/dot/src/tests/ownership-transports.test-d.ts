/** Ownership callbacks remain visible through every authoring and mount form. */
import { expectTypeOf } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { child, cleanup, resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type { Provided, UnitCloseFailure, UnitOpenFailure } from '../unit-contract.js';
import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';
import { bindEntrypoint, entrypoint } from '../feature.js';
import { initUnits } from '../init-units.js';
import { lazy } from '../lazy.js';
import { infra, rename, service } from '../unit-contract.js';

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
const direct = infra({ name: 'direct', provides: factories, boot });
const _renamed = rename(direct, { db: 'renamedDb' });
const driving = entrypoint.fromFeatures({ name: 'direct', provides: factories, boot });
const _drivingBound = bindEntrypoint(driving, []);
const _drivenBound = infra.fromFeatures({ name: 'direct', provides: factories, boot }).bind([]);
const factory = initUnits.context<{ count: number; db: SuccessOf<typeof open> }>().create();
const byKeys = factory.infra({ name: 'keys', needs: ['count'], provides: factories, boot });
const _byWitness = factory.infra({ name: 'witness', needs: { count: service<number>() }, provides: factories, boot });
const chain = defineFeature('chain').provides(factories).entrypoints();
const childFeature = defineFeature('parent.child').provides(factories).entrypoints();
const parent = defineFeature('parent').features(childFeature).entrypoints();
const _withInfra = defineFeature('infra').infra(direct).entrypoints();
const instanced = chain.instance('copy');
const lazyHandle = lazy(open, { dispose: close });
const _lazyUnit = infra({ name: 'lazy', provides: { db: () => lazyHandle } });
const _chainLazy = defineFeature('chain-lazy')
  .provides({ db: () => lazyHandle })
  .entrypoints();

type OpenOfDirect = UnitOpenFailure<typeof direct>;
type CloseOfDirect = UnitCloseFailure<typeof direct>;
type OwnedForms =
  typeof _renamed | (readonly [typeof _drivingBound, typeof _drivenBound])[number] | typeof byKeys | typeof _byWitness;
// Renamed keeps both phases exact.
expectTypeOf<UnitOpenFailure<typeof _renamed>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<UnitCloseFailure<typeof _renamed>>().toEqualTypeOf<CloseOfDirect>();
// An entrypoint binder keeps both phases exact.
expectTypeOf<UnitOpenFailure<typeof _drivingBound>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<UnitCloseFailure<typeof _drivingBound>>().toEqualTypeOf<CloseOfDirect>();
// An infra binder keeps both phases exact.
expectTypeOf<UnitOpenFailure<typeof _drivenBound>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<UnitCloseFailure<typeof _drivenBound>>().toEqualTypeOf<CloseOfDirect>();
// Keys keeps both phases exact.
expectTypeOf<UnitOpenFailure<typeof byKeys>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<UnitCloseFailure<typeof byKeys>>().toEqualTypeOf<CloseOfDirect>();
// Witness keeps both phases exact.
expectTypeOf<UnitOpenFailure<typeof _byWitness>>().toEqualTypeOf<OpenOfDirect>();
expectTypeOf<UnitCloseFailure<typeof _byWitness>>().toEqualTypeOf<CloseOfDirect>();
// ChainService
expectTypeOf<Provided<typeof chain.provides.db>>().toEqualTypeOf<SuccessOf<typeof open>>();
// ChainOpen
expectTypeOf<UnitOpenFailure<ReturnType<typeof chain.units>[0]>>().toEqualTypeOf<FailureOf<typeof open>>();
// ChainClose
expectTypeOf<UnitCloseFailure<ReturnType<typeof chain.units>[0]>>().toEqualTypeOf<FailureOf<typeof close>>();
// NestedOpen
expectTypeOf<UnitOpenFailure<ReturnType<typeof parent.units>[0]>>().toEqualTypeOf<FailureOf<typeof open>>();
// NestedClose
expectTypeOf<UnitCloseFailure<ReturnType<typeof parent.units>[0]>>().toEqualTypeOf<FailureOf<typeof close>>();
// InfraOpen
expectTypeOf<UnitOpenFailure<ReturnType<typeof _withInfra.units>[0]>>().toEqualTypeOf<OpenOfDirect>();
// InfraClose
expectTypeOf<UnitCloseFailure<ReturnType<typeof _withInfra.units>[0]>>().toEqualTypeOf<CloseOfDirect>();
// InstanceOpen
expectTypeOf<UnitOpenFailure<ReturnType<typeof instanced.units>[0]>>().toEqualTypeOf<FailureOf<typeof open>>();
// InstanceClose
expectTypeOf<UnitCloseFailure<ReturnType<typeof instanced.units>[0]>>().toEqualTypeOf<FailureOf<typeof close>>();
// LazyChainClose
expectTypeOf<UnitCloseFailure<ReturnType<typeof _chainLazy.units>[0]>>().toEqualTypeOf<
  UnitCloseFailure<typeof _lazyUnit>
>();
// NoBareFailure
expectTypeOf<string extends UnitCloseFailure<OwnedForms>['code'] ? true : false>().toEqualTypeOf<false>();

const _directApp = defineApp('direct').infra(direct);
const _drivingApp = defineApp('driver').features([]).entrypoints(driving);
const _drivenApp = defineApp('driven')
  .infra(infra.fromFeatures({ name: 'direct', provides: factories, boot }))
  .features([]);
const _allApp = defineApp('all').infra(direct);
const _infraApp = defineApp('infra').infra(direct);
const _entrypointApp = defineApp('entrypoint').features([]).entrypoints(driving);
const directResource = infra({ name: 'resource', provides: factories });
const _resourceApp = defineApp('resource').infra(directResource);
const _chainApp = defineApp('chain').features([chain]);
const _nestedApp = defineApp('parent').features([parent]);
const _instanceApp = defineApp('instance').features([instanced]);
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
export function consumers(value: Provided<typeof chain.provides.db>) {
  const database = defineApp('chain').features([chain]);
  const adapters = defineApp('adapters')
    .infra(infra({ name: 'count', provides: { count: () => 1 } }))
    .infra(byKeys);
  void database;
  void adapters;
  // @ts-expect-error A resource descriptor must never reach the service consumer.
  value.prepare(new AbortController().signal);
  // @ts-expect-error Published success must match the context schema, even when acquired through a resource.
  factory.infra({
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
