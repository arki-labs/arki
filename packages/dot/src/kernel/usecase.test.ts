import { runInNewContext } from 'node:vm';
import { describe, expect, expectTypeOf, it } from 'vitest';

import type { Failure } from '@arki/failure';
import { defineFailure, orThrow, UnexpectedDefect } from '@arki/failure';

import type { DepsOf } from '../define-feature.js';
import type { UnitOpenFailure } from '../unit-contract.js';
import type { SupervisedUsecase, SupervisedUsecases } from './usecase.js';
import { defineApp } from '../define-app.js';
import { defineFeature } from '../define-feature.js';
import { superviseUsecase } from './usecase.js';

const Refused = defineFailure('usecase.refused', { status: 409 });

describe('usecase invocation supervision', () => {
  it('preserves plain sync success and the original returned failure', () => {
    const refusal = Refused();
    const run = superviseUsecase((accepted: boolean) => (accepted ? 42 : refusal));
    expect(run(true)).toBe(42);
    expect(run(false)).toBe(refusal);
    expect(run(true)).not.toBeInstanceOf(Promise);
  });

  it('contains throws and native promise rejections, including thrown declared failures', async () => {
    const cause = new Error('private');
    const thrown = superviseUsecase(() => {
      throw cause;
    })();
    expect(UnexpectedDefect.is(thrown)).toBe(true);
    expect(thrown.cause).toBe(cause);
    const rejected = await superviseUsecase(() => Promise.reject(cause))();
    expect(rejected).toMatchObject({ code: UnexpectedDefect.code, cause });
    const refusal = Refused();
    expect(
      superviseUsecase(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberately violate the value-return contract at the tested boundary.
        throw refusal;
      })(),
    ).toMatchObject({ code: UnexpectedDefect.code, cause: refusal });
  });

  it('contains native promise rejections from another realm without reading its own then accessor', async () => {
    const foreign: unknown = runInNewContext(`
      const result = Promise.reject(new Error('foreign realm'));
      Object.defineProperty(result, 'then', { get() { throw new Error('own then must not run'); } });
      result;
    `);
    const result = await Promise.resolve(superviseUsecase(() => foreign)());
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!UnexpectedDefect.is(result)) throw new Error('expected supervised defect');
    expect(result.cause).toMatchObject({ message: 'foreign realm' });
  });

  it('preserves fulfilled foreign promises and does not inspect lazy then accessors', async () => {
    const foreign: unknown = runInNewContext('Promise.resolve({ id: "foreign" })');
    const result = await Promise.resolve(superviseUsecase(() => foreign)());
    expect(result).toBe(await Promise.resolve(foreign));
    let inspected = false;
    // eslint-disable-next-line unicorn/no-thenable -- Verify that observing a native promise never executes deferred query accessors.
    const deferred = Object.defineProperty({}, 'then', {
      get() {
        inspected = true;
        throw new Error('deferred');
      },
    });
    expect(superviseUsecase(() => deferred)()).toBe(deferred);
    expect(inspected).toBe(false);
  });

  it('does not assimilate lazy thenables as owned promises', () => {
    const lazy = {
      // eslint-disable-next-line unicorn/no-thenable -- Query-builder thenables must remain lazy.
      then: () => {
        throw new Error('must not execute');
      },
    };
    expect(superviseUsecase(() => lazy)()).toBe(lazy);
  });

  it('preserves receiver, arguments and every own property descriptor', () => {
    const privateKey = Symbol('declared failures');
    const run = Object.defineProperties(
      function (this: { base: number }, offset: number) {
        return this.base + offset;
      },
      { failures: { value: [Refused], enumerable: false }, [privateKey]: { get: () => Refused } },
    );
    const wrapped = superviseUsecase(run);
    expect(wrapped.call({ base: 3 }, 4)).toBe(7);
    expect(Object.getOwnPropertyDescriptors(wrapped)).toMatchObject(Object.getOwnPropertyDescriptors(run));
    expect(Reflect.get(wrapped, privateKey)).toBe(Refused);
    expect(superviseUsecase(refusedValue)).toBe(refusedValue);
  });

  const refusedValue = Refused();

  it('types sync and async defects, declared failures, receiver and properties', () => {
    const run = Object.assign(
      function (this: { base: number }, offset: number) {
        return offset > 0 ? this.base + offset : Refused();
      },
      { failures: [Refused] },
    );
    const wrapped = superviseUsecase(run);
    expectTypeOf<Parameters<typeof wrapped>>().toEqualTypeOf<[offset: number]>();
    expectTypeOf<ThisParameterType<typeof wrapped>>().toEqualTypeOf<{ base: number }>();
    expectTypeOf<ReturnType<typeof wrapped>>().toEqualTypeOf<
      number | ReturnType<typeof Refused> | ReturnType<typeof UnexpectedDefect>
    >();
    expectTypeOf(wrapped.failures).toEqualTypeOf(run.failures);
    const asyncRun = superviseUsecase((value: string) => Promise.resolve(value));
    expect(asyncRun).toBeTypeOf('function');
    expectTypeOf<ReturnType<typeof asyncRun>>().toEqualTypeOf<
      Promise<string | ReturnType<typeof UnexpectedDefect>> | ReturnType<typeof UnexpectedDefect>
    >();
    type Services = SupervisedUsecases<{ run: typeof run; label: string }>;
    expectTypeOf<Services['run']>().toEqualTypeOf<typeof wrapped>();
    expectTypeOf<Services['label']>().toEqualTypeOf<string>();
  });

  it('rejects dependent generic returns and overloads instead of silently erasing them', () => {
    const identity = <Value>(value: Value): Value => value;
    expectTypeOf<SupervisedUsecase<typeof identity>>().toEqualTypeOf<never>();
    // @ts-expect-error dependent generics need an explicit concrete invocation signature
    superviseUsecase(identity);
    const constrained = <Value extends { id: string }>(value: Value): Value => value;
    expectTypeOf<SupervisedUsecase<typeof constrained>>().toEqualTypeOf<never>();
    // @ts-expect-error constrained generics also lose dependent return identity
    superviseUsecase(constrained);
    function overloaded(value: string): string;
    function overloaded(value: number): number;
    function overloaded(value: string | number): string | number {
      return value;
    }
    expectTypeOf<SupervisedUsecase<typeof overloaded>>().toEqualTypeOf<never>();
    // @ts-expect-error the last overload cannot stand in for the entire overload set
    superviseUsecase(overloaded);
    const classify = <Value>(value: Value): string => typeof value;
    expect(superviseUsecase(classify)(123)).toBe('number');
  });
});

describe('feature usecase construction', () => {
  it('stops on a returned creation refusal before later factories or providers can consume it', async () => {
    const refused = Refused();
    let laterFactoryRan = false;
    let providerRan = false;
    const feature = defineFeature('creation-refusal')
      .usecases({
        first: async () => refused,
        later: () => {
          laterFactoryRan = true;
          return () => 42;
        },
      })
      .provides({
        result: () => {
          providerRan = true;
          return 42;
        },
      })
      .entrypoints();
    expect(await defineApp('creation-refusal').features([feature]).boot()).toBe(refused);
    expect(laterFactoryRan).toBe(false);
    expect(providerRan).toBe(false);
  });

  it('contains factory throws and rejections independently of invocation', async () => {
    const cause = new Error('creation defect');
    const sync = defineFeature('creation-throw')
      .usecases({
        run: () => {
          throw cause;
        },
      })
      .entrypoints();
    const asyncFeature = defineFeature('creation-reject')
      .usecases({ run: () => Promise.reject(cause) })
      .entrypoints();
    expect(await defineApp('creation-throw').features([sync]).boot()).toMatchObject({
      code: UnexpectedDefect.code,
      cause,
    });
    expect(await defineApp('creation-reject').features([asyncFeature]).boot()).toMatchObject({
      code: UnexpectedDefect.code,
      cause,
    });
  });

  it('publishes awaited callable values while keeping creation failures separate from invocation failures', async () => {
    const ConstructionRefused = defineFailure('usecase.construction_refused', { status: 503 });
    const availability = { ready: true };
    const create = async () =>
      availability.ready
        ? (accepted: boolean): number | ReturnType<typeof Refused> => (accepted ? 42 : Refused())
        : ConstructionRefused();
    const feature = defineFeature('async-usecase').usecases({ run: create }).entrypoints();
    type Unit = ReturnType<typeof feature.units>[0];
    expectTypeOf<UnitOpenFailure<Unit>>().toEqualTypeOf<ReturnType<typeof ConstructionRefused>>();
    const app = orThrow(await defineApp('async-usecase').features([feature]).boot());
    const run = app.services['async-usecase.usecases'].run;
    expectTypeOf<ReturnType<typeof run>>().toEqualTypeOf<
      number | ReturnType<typeof Refused> | ReturnType<typeof UnexpectedDefect>
    >();
    expect(run(true)).toBe(42);
    expect(run(false)).toMatchObject({ code: Refused.code });
    orThrow(await app.dispose());
  });

  it('retains concrete usecases from a generic factory source', () => {
    function creators<Source extends { id: string }>(source: Source) {
      return { read: () => () => source };
    }
    const source = { id: 'typed', rank: 3 };
    const feature = defineFeature('generic-source').usecases(creators(source)).entrypoints();
    type Services = DepsOf<typeof feature>;
    expectTypeOf<ReturnType<Services['usecases']['read']>>().toEqualTypeOf<
      typeof source | ReturnType<typeof UnexpectedDefect>
    >();
    expect(feature.name).toBe('generic-source');
  });

  it('rejects unsupported signatures at authoring with a named diagnostic', () => {
    const opaque = (): unknown => Refused();
    // @ts-expect-error DOT: unknown creations hide returned failures
    defineFeature('opaque-creation').usecases({ opaque });
    const broad = (): Failure => Refused();
    // @ts-expect-error DOT: creation failures retain concrete failure codes
    defineFeature('broad-creation').usecases({ broad });
    const asyncOpaque = (): Promise<unknown> => Promise.resolve(Refused());
    // @ts-expect-error DOT: awaiting an opaque creation cannot recover its failure codes
    defineFeature('opaque-async-creation').usecases({ asyncOpaque });
    const indexed: Readonly<Record<string, () => unknown>> = { run: opaque };
    // @ts-expect-error DOT: an indexed factory source must also retain its concrete creation outputs
    defineFeature('indexed-opaque-creation').usecases(indexed);
    const asyncBroad = (): Promise<Failure> => Promise.resolve(Refused());
    // @ts-expect-error DOT: awaiting a broad failure cannot recover its concrete failure code
    defineFeature('broad-async-creation').usecases({ asyncBroad });
    const generic =
      () =>
      <Value>(value: Value): Value =>
        value;
    // @ts-expect-error DOT: dependent generic invocation needs a concrete signature
    defineFeature('unsupported-generic').usecases({ generic });
  });
});

// A void annotation can conceal a refusal at the creation boundary.
// eslint-disable-next-line failure/must-use -- Negative fixture intentionally hides a failure behind void to verify the authoring guard rejects it.
const erasedCreation: () => void = () => Refused();
// @ts-expect-error Creation must retain its value and failure channels.
defineFeature('erased-creation').usecases({ run: erasedCreation });
// @ts-expect-error Async creation cannot conceal a refusal behind Promise<void>.
defineFeature('erased-async-creation').usecases({ run: async () => erasedCreation() });

// The invoked function must also retain its actual return, independently of its factory.
// eslint-disable-next-line failure/must-use -- Negative fixture intentionally hides a failure behind void to verify the authoring guard rejects it.
const erasedInvocation: () => void = () => Refused();
// @ts-expect-error An invoked void return could hide a business failure.
defineFeature('erased-invocation').usecases({ run: () => erasedInvocation });
// @ts-expect-error An invoked Promise<void> return could hide a business failure.
defineFeature('erased-async-invocation').usecases({ run: () => async () => erasedInvocation() });
// @ts-expect-error An unknown invocation result also erases the refusal channel.
defineFeature('unknown-invocation').usecases({ run: () => (): unknown => Refused() });
