/** Optional entries and disjoint record branches must retain every owned failure channel. */
import { expectTypeOf } from 'vitest';

import type { FailureOf } from '@arki/failure';
import { child, cleanup, resource } from '@arki/async';
import { defineFailure } from '@arki/failure';

import type { InferredOwnership, UnitCloseFailure, UnitOpenFailure } from '../unit-contract.js';

const definitions = {
  provider: defineFailure('test.ownership_unions.provider'),
  otherProvider: defineFailure('test.ownership_unions.other_provider'),
  resourceOpen: defineFailure('test.ownership_unions.resource_open'),
  resourceClose: defineFailure('test.ownership_unions.resource_close'),
  bootOpen: defineFailure('test.ownership_unions.boot_open'),
  bootClose: defineFailure('test.ownership_unions.boot_close'),
  task: defineFailure('test.ownership_unions.task'),
  cleanup: defineFailure('test.ownership_unions.cleanup'),
};
const _openDefinitions = {
  provider: definitions.provider,
  otherProvider: definitions.otherProvider,
  resourceOpen: definitions.resourceOpen,
  bootOpen: definitions.bootOpen,
  task: definitions.task,
};
const _closeDefinitions = {
  resourceClose: definitions.resourceClose,
  bootClose: definitions.bootClose,
  task: definitions.task,
  cleanup: definitions.cleanup,
};
type OpenFailure = FailureOf<(typeof _openDefinitions)[keyof typeof _openDefinitions]>;
type CloseFailure = FailureOf<(typeof _closeDefinitions)[keyof typeof _closeDefinitions]>;

const refused: () => boolean = () => false;
const _factories = {
  left: () => definitions.provider(),
  right: () => definitions.otherProvider(),
  owned: () =>
    resource(
      () => (refused() ? definitions.resourceOpen() : { value: 1 }),
      () => definitions.resourceClose(),
    ),
};
const _bootPlan = {
  task: child(() => definitions.task()),
  owned: resource(
    () => (refused() ? definitions.bootOpen() : { value: 1 }),
    () => definitions.bootClose(),
  ),
  cleanup: cleanup(() => definitions.cleanup()),
};
type Values = { [Key in keyof typeof _factories]: ReturnType<(typeof _factories)[Key]> };
type OptionalValues = Partial<Values>;
type OptionalPlan = Partial<typeof _bootPlan>;
type OptionalOwnership = InferredOwnership<OptionalValues, OptionalPlan>;
expectTypeOf<OptionalOwnership['open']>().toEqualTypeOf<OpenFailure>();
expectTypeOf<OptionalOwnership['close']>().toEqualTypeOf<CloseFailure>();

// Every branch has different keys: indexing only their common keys would erase all failures.
type UnionValues = Pick<Values, 'left'> | Pick<Values, 'right' | 'owned'>;
type UnionPlan = Pick<typeof _bootPlan, 'task'> | Pick<typeof _bootPlan, 'owned' | 'cleanup'>;
type UnionOwnership = InferredOwnership<UnionValues, UnionPlan>;
expectTypeOf<UnionOwnership['open']>().toEqualTypeOf<OpenFailure>();
expectTypeOf<UnionOwnership['close']>().toEqualTypeOf<CloseFailure>();

type OptionalSource = {
  readonly factories: Partial<typeof _factories>;
  readonly hooks: { readonly boot: () => OptionalPlan };
};
expectTypeOf<UnitOpenFailure<OptionalSource>>().toEqualTypeOf<OpenFailure>();
expectTypeOf<UnitCloseFailure<OptionalSource>>().toEqualTypeOf<CloseFailure>();

type UnionSource = {
  readonly factories: Pick<typeof _factories, 'left'> | Pick<typeof _factories, 'right' | 'owned'>;
  readonly hooks: { readonly boot: () => UnionPlan };
};
expectTypeOf<UnitOpenFailure<UnionSource>>().toEqualTypeOf<OpenFailure>();
expectTypeOf<UnitCloseFailure<UnionSource>>().toEqualTypeOf<CloseFailure>();

expectTypeOf<Extract<OptionalOwnership['open'], undefined>>().toEqualTypeOf<never>();
expectTypeOf<Extract<OptionalOwnership['close'], undefined>>().toEqualTypeOf<never>();
expectTypeOf<Extract<UnionOwnership['open'], undefined>>().toEqualTypeOf<never>();
expectTypeOf<Extract<UnionOwnership['close'], undefined>>().toEqualTypeOf<never>();
expectTypeOf<Extract<UnitOpenFailure<OptionalSource | UnionSource>, undefined>>().toEqualTypeOf<never>();
expectTypeOf<Extract<UnitCloseFailure<OptionalSource | UnionSource>, undefined>>().toEqualTypeOf<never>();
