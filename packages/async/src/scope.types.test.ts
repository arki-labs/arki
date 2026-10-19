import { expectTypeOf, it } from 'vitest';

import type { FailureOf, SuccessOf } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import type { ScopeAggregate, SupervisorFailure } from './errors.js';
import type { Child, ChildFailure, Cleanup, CleanupFailure, OpenFailure, Resource, ScopePlan } from './scope.js';
import { child, cleanup, createLifetime, dynamicScope, openScope, resource, scoped } from './scope.js';

const Refused = defineFailure('scope_types.refused');
const CloseRefused = defineFailure('scope_types.close_refused');
const ChildRefused = defineFailure('scope_types.child_refused');
const Foreign = defineFailure('scope_types.foreign');
// Exact executable API type proofs (not ambient executor declarations).
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
const maybe = false as boolean;
const openDb = () => (maybe ? Refused() : { query: () => 42 });
const closeDb = (db: SuccessOf<typeof openDb>) => {
  void db.query();
  return maybe ? CloseRefused() : undefined;
};
const runChild = () => (maybe ? ChildRefused() : undefined);
const plan = { db: resource(openDb, closeDb), watch: child(runChild) };
const _conditionalPlan = {
  db: maybe ? resource(openDb, closeDb) : cleanup(() => void 0),
  watch: maybe ? child(runChild) : cleanup(() => void 0),
};
const _operation = () => scoped(plan, ({ db }) => db.query());
type ExactResourceFailure = Assert<Equal<OpenFailure<typeof plan>, FailureOf<typeof openDb>>>;
type ExactCleanupFailure = Assert<Equal<CleanupFailure<typeof plan>, FailureOf<typeof closeDb>>>;
type ExactChildFailure = Assert<Equal<ChildFailure<typeof plan>, FailureOf<typeof runChild>>>;
type ExactSuccess = Assert<Equal<SuccessOf<typeof _operation>, number>>;
type NoFailureWidening = Assert<Equal<string extends FailureOf<typeof _operation>['code'] ? true : false, false>>;
type ExactFailure = Assert<
  Equal<
    FailureOf<typeof _operation>,
    | FailureOf<typeof openDb>
    | FailureOf<typeof closeDb>
    | FailureOf<typeof runChild>
    | SupervisorFailure
    | ScopeAggregate<
        FailureOf<typeof openDb> | FailureOf<typeof runChild> | SupervisorFailure,
        FailureOf<typeof closeDb> | SupervisorFailure
      >
  >
>;
const typedLifetime = () =>
  createLifetime<FailureOf<typeof openDb> | FailureOf<typeof runChild>, FailureOf<typeof closeDb>>({});
const _lifetimeAcquire = () => typedLifetime().acquire(resource(openDb, closeDb).prepare);
type TypedLifetimeResource = Assert<Equal<SuccessOf<typeof _lifetimeAcquire>, SuccessOf<typeof openDb>>>;
type TypedLifetimeClose = Assert<
  Equal<
    FailureOf<ReturnType<typeof typedLifetime>['close']>,
    | FailureOf<typeof openDb>
    | FailureOf<typeof runChild>
    | FailureOf<typeof closeDb>
    | SupervisorFailure
    | ScopeAggregate<
        FailureOf<typeof openDb> | FailureOf<typeof runChild> | SupervisorFailure,
        FailureOf<typeof closeDb> | SupervisorFailure
      >
  >
>;
function compilerNegatives() {
  // @ts-expect-error fixed typed lifetime refuses foreign finalizer failures.
  typedLifetime().defer(() => Foreign());
  // @ts-expect-error fixed typed lifetime refuses foreign child failures.
  typedLifetime().fork(() => Foreign());
  const foreignResource = resource(
    () => Foreign(),
    () => void 0,
  );
  // @ts-expect-error fixed typed lifetime refuses foreign resource acquisition failures.
  void typedLifetime().acquire(foreignResource.prepare);
  // @ts-expect-error fixed typed lifetime refuses foreign resource cleanup failures.
  void typedLifetime().acquire(resource(openDb, () => Foreign()).prepare);
  const unknownOpen = resource(
    (): unknown => Refused(),
    () => void 0,
  );
  // @ts-expect-error unknown acquisition output cannot hide a refusal.
  void scoped({ bad: unknownOpen }, () => 42);
  const unknownClose = resource(
    () => 42,
    (): unknown => CloseRefused(),
  );
  // @ts-expect-error unknown resource cleanup output cannot hide a refusal.
  void scoped({ bad: unknownClose }, () => 42);
  // @ts-expect-error unknown child output cannot hide a refusal.
  void scoped({ bad: child((): unknown => ChildRefused()) }, () => 42);
  // @ts-expect-error unknown deferred cleanup output cannot hide a refusal.
  void scoped({ bad: cleanup((): unknown => CloseRefused()) }, () => 42);
  const fabricated = { kind: 'resource', prepare: () => Promise.resolve({ value: 42, close: () => void 0 }) };
  // @ts-expect-error fabricated descriptors cannot bypass the closed factory.
  void scoped({ fake: fabricated }, () => 42);
  // @ts-expect-error acquired resource cannot be an acquisition refusal.
  resource(openDb, db => db.code);
  void dynamicScope([CloseRefused]).run(scope => {
    // @ts-expect-error unlisted asynchronous finalizer refusal cannot widen scope.
    scope.defer(() => Promise.resolve(Foreign()));
  });
}

const _unknownBody = () => scoped({}, (): unknown => 42);
const _asyncUnknownBody = () => scoped({}, (): Promise<unknown> => Promise.resolve(42));
type UnknownStaysUnknown = Assert<Equal<Awaited<ReturnType<typeof _unknownBody>>, unknown>>;
type AsyncUnknownStaysUnknown = Assert<Equal<Awaited<ReturnType<typeof _asyncUnknownBody>>, unknown>>;
const _owner = () => openScope(plan);
type CloseDoesNotAcquire = Assert<
  Equal<Extract<FailureOf<SuccessOf<typeof _owner>['close']>, FailureOf<typeof openDb>>, never>
>;
// Compile fixtures are wrapped so rejected examples never execute.
void compilerNegatives;
it('preserves precise resource values in the inferred public callback', () => {
  expectTypeOf<SuccessOf<typeof _operation>>().toEqualTypeOf<number>();
});

it('preserves failures when a runtime choice selects different descriptor kinds', () => {
  expectTypeOf<OpenFailure<typeof _conditionalPlan>>().toEqualTypeOf<FailureOf<typeof openDb>>();
  expectTypeOf<CleanupFailure<typeof _conditionalPlan>>().toEqualTypeOf<FailureOf<typeof closeDb>>();
  expectTypeOf<ChildFailure<typeof _conditionalPlan>>().toEqualTypeOf<FailureOf<typeof runChild>>();
});

it('checks every exact compiler contract', () => {
  expectTypeOf<
    [
      ExactResourceFailure,
      ExactCleanupFailure,
      ExactChildFailure,
      ExactSuccess,
      NoFailureWidening,
      ExactFailure,
      TypedLifetimeResource,
      TypedLifetimeClose,
      UnknownStaysUnknown,
      AsyncUnknownStaysUnknown,
      CloseDoesNotAcquire,
    ]
  >().toEqualTypeOf<[true, true, true, true, true, true, true, true, true, true, true]>();
});

function _rejectErasedFailureContracts() {
  // @ts-expect-error A void annotation cannot discard an owned cleanup failure.
  const _resource: Resource<number, void> = resource(
    () => 42,
    () => Refused(),
  );
  // @ts-expect-error A void annotation cannot discard a finalizer failure.
  const _cleanup: Cleanup<void> = cleanup(() => Refused());
  // @ts-expect-error A void annotation cannot discard a child failure.
  const _child: Child<void> = child(() => Refused());
  const erasedPlan: ScopePlan = {
    db: resource(
      () => Refused(),
      () => void 0,
    ),
  };
  // @ts-expect-error An erased plan cannot prove the admitted callback outcomes.
  void scoped(erasedPlan, () => 42);
  // @ts-expect-error The open handle also requires the original inferred plan.
  void openScope(erasedPlan);
}
void _rejectErasedFailureContracts;
