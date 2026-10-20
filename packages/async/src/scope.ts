/** Owned resources and child work with callback-inferred failure contracts. */
import type { Failure, FailureDefinition, FailureIn, FailureOf } from '@arki/failure';
import { CLOCK_ERROR_CODES, ClockError } from '@arki/clock';
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { ScopeAggregate, SupervisorFailure } from './errors.js';
import { ASYNC_ERROR_CODES, AsyncError, Cancelled, Deadline, scopeAggregate } from './errors.js';
import { scopeTelemetry } from './scope-telemetry.js';
import { linkedController } from './signal.js';

const EntryTag: unique symbol = Symbol('scope.entry');
function acquired<Value>(value: Value): value is Exclude<Value, Failure> {
  return !isFailure<unknown>(value);
}
function refused<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}
type SignalTask<Result> = (signal: AbortSignal) => Result;
type ResourceClose<Opened, Closed> = (value: Exclude<Awaited<Opened>, Failure>) => Closed;
type CleanupTask<Result> = () => Result;
function createResource<Opened, Closed>(open: SignalTask<Opened>, close: ResourceClose<Opened, Closed>) {
  // Promise returns preserve output variance: a Failure cannot be discarded as void.
  const acquire = async (signal: AbortSignal) => open(signal);
  const release = async (value: Exclude<Awaited<Opened>, Failure>) => close(value);
  return {
    [EntryTag]: true as const,
    kind: 'resource' as const,
    open: acquire,
    close: release,
    async prepare(this: void, signal: AbortSignal) {
      const value = await acquire(signal);
      if (refused(value)) return value;
      if (acquired(value)) return { value, close: () => release(value) };
      throw new Error('Unreachable resource result');
    },
  };
}
function createCleanup<Closed>(close: CleanupTask<Closed>) {
  return { [EntryTag]: true as const, kind: 'cleanup' as const, close: async () => close() };
}
function createChild<Ran>(run: SignalTask<Ran>) {
  return { [EntryTag]: true as const, kind: 'child' as const, run: async (signal: AbortSignal) => run(signal) };
}
/** Named inferred descriptor types keep consumer declarations independent of private brands. */
// Named object identities are required for exported consumer declarations; members stay inferred.
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface Resource<Opened, Closed> extends ReturnType<typeof createResource<Opened, Closed>> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface Cleanup<Closed> extends ReturnType<typeof createCleanup<Closed>> {}
// eslint-disable-next-line @typescript-eslint/no-empty-object-type, @typescript-eslint/consistent-type-definitions
export interface Child<Ran> extends ReturnType<typeof createChild<Ran>> {}
/** Define an acquisition and its correlated finalizer without starting either. */
export function resource<Opened, Closed>(
  open: SignalTask<Opened>,
  close: ResourceClose<Opened, Closed>,
): Resource<Opened, Closed> {
  return createResource(open, close);
}
/** Define a finalizer whose failure contract participates in scope closure. */
export function cleanup<Closed>(close: CleanupTask<Closed>): Cleanup<Closed> {
  return createCleanup(close);
}
/** Define child work whose settlement is joined before resource finalization. */
export function child<Ran>(run: SignalTask<Ran>): Child<Ran> {
  return createChild(run);
}
/** Recognize an inert resource without acquiring it. */
export function isResource(value: unknown): value is ReturnType<typeof resource> {
  return isScopeEntry(value) && value.kind === 'resource';
}
/** Recognize a descriptor constructed by this module. */
export function isScopeEntry(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && EntryTag in value && value[EntryTag] === true;
}
// Only executable closure fields are erased. Raw resource close callbacks never
// cross this seam, so unknown success is never asserted into a resource type.
type Entry =
  | Pick<ReturnType<typeof resource>, typeof EntryTag | 'kind' | 'prepare'>
  | ReturnType<typeof cleanup>
  | ReturnType<typeof child>;
export type ScopePlan = Readonly<Record<string, Entry>>;
type Plan = ScopePlan;
type CallbackOutput<Descriptor> = Descriptor extends unknown
  ? {
      [Key in keyof Descriptor]: Descriptor[Key] extends (...args: never[]) => infer Result ? Awaited<Result> : never;
    }[keyof Descriptor]
  : never;
/** Require inferred callback outcomes before an owner accepts a descriptor plan. */
export type CheckedPlan<P extends Plan> = { [Key in keyof P]: unknown extends CallbackOutput<P[Key]> ? never : P[Key] };
type DescriptorFailure<Descriptor, Key extends PropertyKey> =
  Descriptor extends Record<Key, infer Fn extends (...args: never[]) => unknown> ? FailureOf<Fn> : never;
type CallbackFailure<P extends Plan, Key extends PropertyKey> = {
  [Name in keyof P]: DescriptorFailure<P[Name], Key>;
}[keyof P];
export type OpenFailure<P extends Plan> = CallbackFailure<P, 'open'>;
export type CleanupFailure<P extends Plan> = CallbackFailure<P, 'close'>;
export type ChildFailure<P extends Plan> = CallbackFailure<P, 'run'>;
export type Values<P extends Plan> = {
  readonly [
    Name in keyof P as P[Name] extends { kind: ReturnType<typeof resource>['kind'] } ? Name : never
  ]: P[Name] extends { open: (...args: never[]) => infer Opened } ? Exclude<Awaited<Opened>, Failure> : never;
};
type Outcome<Value, Primary extends Failure, Cleanup extends Failure> =
  Value | Primary | Cleanup | ScopeAggregate<Primary, Cleanup>;
type Primary<P extends Plan> = OpenFailure<P> | ChildFailure<P> | SupervisorFailure;
type Closing<P extends Plan> = CleanupFailure<P> | SupervisorFailure;
export type ScopeOptions = { readonly signal?: AbortSignal; readonly deadline?: AbortSignal };

// One outcome reducer retains exact original failures; no extra wrapper on success.
function finish<Value, Primary extends Failure, Cleanup extends Failure>(
  value: Value,
  primary: readonly Primary[],
  cleanup: readonly Cleanup[],
) {
  if (primary.length === 0 && cleanup.length === 0) return value;
  if (primary.length === 1 && cleanup.length === 0) return primary[0];
  if (primary.length === 0 && cleanup.length === 1) return cleanup[0];
  return scopeAggregate(primary, cleanup);
}

export function openScope<const P extends Plan>(
  plan: P & CheckedPlan<NoInfer<P>>,
  options?: ScopeOptions,
): Promise<
  | {
      readonly values: Values<P>;
      readonly signal: AbortSignal;
      close(this: void): Promise<Outcome<void, ChildFailure<P> | SupervisorFailure, Closing<P>>>;
    }
  | Primary<P>
  | CleanupFailure<P>
  | ScopeAggregate<Primary<P>, Closing<P>>
>;
export async function openScope(plan: Plan, options: ScopeOptions = {}): Promise<unknown> {
  return openScopeRuntime(plan, options);
}
async function openScopeRuntime(plan: Plan, options: ScopeOptions = {}) {
  const state = lifetimeRuntime(options);
  for (const [name, entry] of Object.entries(plan)) {
    if (state.signal.aborted) break;
    if (entry.kind === 'resource') {
      const opened = await state.acquire(entry.prepare);
      if (refused(opened)) {
        state.fail(opened);
        break;
      }
      Object.defineProperty(state.values, name, { value: opened, enumerable: true });
    } else if (entry.kind === 'cleanup') {
      // eslint-disable-next-line failure/must-use -- The owner already retains signal cancellation and closes below.
      state.defer(entry.close);
    } else {
      // eslint-disable-next-line failure/must-use -- The owner already retains signal cancellation and joins the child below.
      state.fork(entry.run);
    }
  }
  if (state.signal.aborted || state.hasFailure()) {
    const failed = await state.close();
    return refused(failed) ? failed : UnexpectedDefect({ cause: new Error('Failed scope lost its failure') });
  }
  return {
    values: state.values,
    signal: state.signal,
    close: state.close,
    async complete(body: (values: Readonly<Record<string, unknown>>, signal: AbortSignal) => unknown) {
      let value: unknown;
      try {
        value = await state.run(() => body(state.values, state.signal));
        if (refused(value)) state.fail(value);
      } catch (error) {
        const failure = state.defect(error);
        if (failure !== undefined) state.fail(failure);
      }
      const closed = await state.close();
      return refused(closed) ? closed : value;
    },
  };
}

export function scoped<const P extends Plan, Result>(
  plan: P & CheckedPlan<NoInfer<P>>,
  body: (values: Values<P>, signal: AbortSignal) => Result,
  options?: ScopeOptions,
): Promise<Outcome<Exclude<Awaited<Result>, Failure>, Primary<P> | Extract<Awaited<Result>, Failure>, Closing<P>>>;
export async function scoped(
  plan: Plan,
  body: (values: Readonly<Record<string, unknown>>, signal: AbortSignal) => unknown,
  options: ScopeOptions = {},
) {
  const opened = await openScopeRuntime(plan, options);
  if (refused(opened)) return opened;
  return opened.complete(body);
}

type Prepare = ReturnType<typeof resource>['prepare'];
type PreparedSuccess<Run extends Prepare> = Exclude<Awaited<ReturnType<Run>>, Failure>;
type PreparedValue<Run extends Prepare> = PreparedSuccess<Run> extends { value: infer Value } ? Value : never;
type PreparedClose<Run extends Prepare> =
  PreparedSuccess<Run> extends { close: infer Close extends () => unknown } ? Close : never;
type CoveredCallback<Run extends (...args: never[]) => unknown, Allowed extends Failure> =
  unknown extends Awaited<ReturnType<Run>>
    ? never
    : [Exclude<FailureOf<Run>, Allowed>] extends [never]
      ? unknown
      : never;
export function createLifetime<Primary extends Failure = never, Cleanup extends Failure = never>(
  options: ScopeOptions,
): {
  readonly signal: AbortSignal;
  readonly values: Record<string, unknown>;
  acquire<Run extends Prepare>(
    prepare: Run &
      CoveredCallback<Run, Primary | SupervisorFailure> &
      CoveredCallback<PreparedClose<Run>, Cleanup | SupervisorFailure>,
  ): Promise<PreparedValue<Run> | FailureOf<Run> | SupervisorFailure>;
  defer<Run extends () => unknown>(
    run: Run & CoveredCallback<Run, Cleanup | SupervisorFailure>,
  ): void | SupervisorFailure;
  fork<Ran>(
    this: void,
    run: (signal: AbortSignal) => Ran,
    ...coverage: CoveredCallback<() => Ran, Primary | SupervisorFailure> extends never ? [invalid: never] : []
  ): void | SupervisorFailure;
  fail(failure: Primary | SupervisorFailure): void;
  hasFailure(): boolean;
  defect(error: unknown): FailureOf<typeof UnexpectedDefect> | undefined;
  quiesce(this: void): Promise<Outcome<void, Primary | SupervisorFailure, never>>;
  close(this: void): Promise<Outcome<void, Primary | SupervisorFailure, Cleanup | SupervisorFailure>>;
};
export function createLifetime(options: ScopeOptions): unknown {
  return lifetimeRuntime(options);
}
function lifetimeRuntime(options: ScopeOptions) {
  const telemetry = scopeTelemetry();
  const { controller, unlink } = linkedController();
  const ownedReason = Object.freeze({ owner: 'scope.stop' });
  const primary: Failure[] = [];
  const cleanupFailures: Failure[] = [];
  const finalizers: (() => unknown)[] = [];
  const children: Promise<void>[] = [];
  const acquisitions: Promise<unknown>[] = [];
  const values: Record<string, unknown> = {};
  let admission = true;
  let closing: Promise<ReturnType<typeof finish<void, Failure, Failure>>> | undefined;
  let quieting: Promise<ReturnType<typeof finish<void, Failure, never>>> | undefined;
  const abort = (failure: Failure) => {
    if (Cancelled.is(failure) && failure.cause === ownedReason) return;
    if (!primary.includes(failure)) primary.push(failure);
    controller.abort(ownedReason);
  };
  const onAbort = () => abort(Cancelled({ cause: options.signal?.reason }));
  const onDeadline = () => abort(Deadline({ cause: options.deadline?.reason }));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.deadline?.aborted) onDeadline();
  else options.deadline?.addEventListener('abort', onDeadline, { once: true });
  const normalize = (error: unknown) => {
    if (
      controller.signal.reason === ownedReason &&
      (error === ownedReason ||
        (((error instanceof AsyncError && error.code === ASYNC_ERROR_CODES.aborted) ||
          (error instanceof ClockError && error.code === CLOCK_ERROR_CODES.aborted)) &&
          error.cause === ownedReason))
    )
      return;
    return UnexpectedDefect({ cause: error });
  };
  const finalize = async (run: () => unknown) => {
    try {
      const result = await telemetry.run(run);
      if (refused(result)) cleanupFailures.push(result);
    } catch (error) {
      cleanupFailures.push(UnexpectedDefect({ cause: error }));
    }
  };
  const accepting = () => admission && !controller.signal.aborted;
  function acquire(prepare: ReturnType<typeof resource>['prepare']) {
    if (!accepting()) return Promise.resolve(Cancelled({ cause: ownedReason }));
    // Track admission before user code can synchronously close this lifetime.
    const acquiring = Promise.resolve().then(async () => {
      try {
        const prepared = await telemetry.run(() => prepare(controller.signal));
        if (refused(prepared)) {
          abort(prepared);
          return prepared;
        }
        const run = prepared.close;
        // Even late resources stay alive until every admitted child has joined.
        finalizers.push(() => run());
        return accepting() ? prepared.value : Cancelled({ cause: ownedReason });
      } catch (error) {
        const failure = normalize(error) ?? Cancelled({ cause: ownedReason });
        abort(failure);
        return failure;
      }
    });
    acquisitions.push(acquiring);
    return acquiring;
  }
  function defer(run: () => unknown) {
    if (!admission || controller.signal.aborted) return Cancelled({ cause: ownedReason });
    finalizers.push(run);
    return;
  }
  function fork(run: (signal: AbortSignal) => unknown) {
    if (!admission || controller.signal.aborted) return Cancelled({ cause: ownedReason });
    children.push(
      Promise.resolve()
        .then(() => telemetry.run(() => run(controller.signal)))
        .then(
          value => {
            if (refused(value)) {
              if (Cancelled.is(value) && controller.signal.reason === ownedReason && value.cause === ownedReason)
                return;
              abort(value);
            }
          },
          error => {
            const failure = normalize(error);
            if (failure !== undefined) abort(failure);
          },
        ),
    );
    return;
  }
  function quiesce() {
    if (quieting !== undefined) return quieting;
    admission = false;
    // Abort dispatch is synchronous and can re-enter quiesce/close.
    quieting = Promise.resolve()
      .then(() => Promise.all([...children, ...acquisitions]))
      .then(() => finish(undefined, primary, []));
    if (!controller.signal.aborted) controller.abort(ownedReason);
    return quieting;
  }
  function close() {
    if (closing !== undefined) return closing;
    closing = Promise.resolve().then(async () => {
      // eslint-disable-next-line failure/must-use -- Close reduces the retained primary failures after every finalizer.
      await quiesce();
      for (const finalizer of finalizers.reverse()) await finalize(finalizer);
      options.signal?.removeEventListener('abort', onAbort);
      options.deadline?.removeEventListener('abort', onDeadline);
      unlink();
      const outcome = finish(undefined, primary, cleanupFailures);
      telemetry.end(outcome, primary, cleanupFailures, finalizers.length);
      return outcome;
    });
    // eslint-disable-next-line failure/must-use -- Close returns the retained primary and cleanup failures together.
    void quiesce();
    return closing;
  }
  return {
    values,
    signal: controller.signal,
    acquire,
    defer,
    fork,
    fail: abort,
    hasFailure: () => primary.length > 0,
    defect: normalize,
    quiesce,
    close,
    run: telemetry.run,
  };
}

type Definition = Pick<FailureDefinition, 'code' | 'is' | 'dataSchema'> & ((...args: never[]) => Failure);
type Defined<Definitions extends readonly Definition[]> = ReturnType<Definitions[number]>;
type Covered<Value, Allowed extends Failure> =
  unknown extends Awaited<Value>
    ? never
    : [Exclude<Extract<Awaited<Value>, Failure>, Allowed>] extends [never]
      ? Value
      : never;
function allowedFailure(definitions: readonly Definition[], value: unknown): value is Failure {
  return definitions.some(definition => definition.is(value));
}
/** Fix canonical failure definitions before imperative registrations start. */
export function dynamicScope<const Definitions extends readonly Definition[]>(
  definitions: Definitions,
): {
  run<
    Body extends (scope: {
      readonly signal: AbortSignal;
      acquire<
        Open extends (signal: AbortSignal) => unknown,
        Close extends (value: Exclude<Awaited<ReturnType<Open>>, Failure>) => unknown,
      >(
        open: Open & ((signal: AbortSignal) => Covered<ReturnType<Open>, NoInfer<Defined<Definitions>>>),
        close: Close &
          ((
            value: Exclude<Awaited<ReturnType<Open>>, Failure>,
          ) => Covered<ReturnType<Close>, NoInfer<Defined<Definitions>>>),
      ): Promise<Awaited<ReturnType<Open>> | SupervisorFailure>;
      defer<Close extends () => unknown>(
        this: void,
        close: Close & (() => Covered<ReturnType<Close>, NoInfer<Defined<Definitions>>>),
      ): void | SupervisorFailure;
      fork<Run extends (signal: AbortSignal) => unknown>(
        run: Run & ((signal: AbortSignal) => Covered<ReturnType<Run>, NoInfer<Defined<Definitions>>>),
      ): void | SupervisorFailure;
    }) => unknown,
  >(
    body: Body,
    options?: ScopeOptions,
  ): Promise<
    Outcome<
      Exclude<Awaited<ReturnType<Body>>, Failure>,
      Defined<Definitions> | FailureOf<Body> | SupervisorFailure,
      Defined<Definitions> | SupervisorFailure
    >
  >;
};

export function dynamicScope(definitions: readonly Definition[]): unknown {
  const checked = async (run: () => unknown) => {
    const value = await run();
    if (refused(value) && !allowedFailure(definitions, value)) return UnexpectedDefect({ cause: value });
    return value;
  };
  return {
    async run(body: (scope: ReturnType<typeof runtimeRegistration>) => unknown, options: ScopeOptions = {}) {
      const state = lifetimeRuntime(options);
      const scope = runtimeRegistration(state);
      if (state.signal.aborted) return state.close();
      let value: unknown;
      try {
        value = await state.run(() => body(scope));
        if (refused(value)) state.fail(value);
      } catch (error) {
        const failure = state.defect(error);
        if (failure !== undefined) state.fail(failure);
      }
      const closed = await state.close();
      return refused(closed) ? closed : value;
    },
  };
  function runtimeRegistration(state: ReturnType<typeof lifetimeRuntime>) {
    return {
      signal: state.signal,
      acquire(open: (signal: AbortSignal) => unknown, close: (value: unknown) => unknown) {
        return state.acquire(async signal => {
          const value = await checked(() => open(signal));
          if (refused(value)) return value;
          return { value, close: () => checked(() => close(value)) };
        });
      },
      defer(close: () => unknown) {
        return state.defer(() => checked(close));
      },
      fork(run: (signal: AbortSignal) => unknown) {
        return state.fork(signal => checked(() => run(signal)));
      },
    };
  }
}
