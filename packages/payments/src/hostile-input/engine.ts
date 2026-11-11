/**
 * The hostile-input gate (T08)
 *
 * Every public operation of the package gets one valid call on real objects
 * (PGlite, the real journal, the fake Stripe HTTP layer). The gate then walks
 * the valid arguments and, one leaf at a time, puts in every hostile value
 * the leaf's runtime type allows. Each mutated call must end in one of the
 * documented outcomes:
 *
 * - it resolves to a value, or to a typed failure (`isFailure`, any code);
 * - it throws a `FailureError` from `invariant` (code `ARKI_FAILURE_E008`), a
 *   documented precondition on an already-typed value.
 *
 * Anything else (a Postgres error, a `TypeError`, a `RangeError`, a plain
 * `Error`, a thrown failure such as `payments.configuration_invalid`, a hang) is a defect of the package, and the case fails with the
 * operation, the argument path, the hostile value and the error.
 *
 * Each failing case is also written as one JSON line to
 * `.cache/hostile-input/<area>.jsonl` (the report the fixers work from).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { instant } from '@arki/date';
import { FAILURE_ERROR_CODES, FailureError, isFailure } from '@arki/failure';

/** The package's `src/` folder, where the op keys' file paths start. */
export const srcDir = fileURLToPath(new URL('..', import.meta.url));

/** One step of an argument path: an object key or an array index. */
type PathStep = string | number;

/** One hostile substitution at one argument path. */
type Mutation = {
  path: PathStep[];
  label: string;
  /** Builds the hostile value from the valid one at the same path. */
  value: (valid: unknown) => unknown;
  /** A slow value (100k text, 200k items) gets the long time limit. */
  slow?: boolean;
};

/** One public operation under the gate. Build it with {@link op}; the engine never sees the argument types. */
export type HostileCase<Ctx> = {
  /** `<path under src>::<export>`, `<path>::<Class>.<method>`, `<path>::<Class>` (constructor) or `<path>::<factory>().<fn>`. */
  op: string;
  /** Calls the operation on fresh valid arguments, after `mutate` changed them in place. */
  run: (ctx: Ctx, mutate: (args: unknown[]) => void) => Promise<{ args: unknown[]; result: unknown }>;
  /** Checks the result of the valid call. */
  valid: (result: unknown, ctx: Ctx) => void | Promise<void>;
  /** The result is an object of operations: each function on it must have a case `<op>().<name>`. */
  surface: boolean;
  /** Argument paths (as `args[0].x`) the walk leaves alone, with the reason. */
  keep: Record<string, string>;
  /** Time limit of one call, in ms. */
  timeoutMs: number;
};

type OpOptions<Ctx, Args extends unknown[]> = {
  /** Fresh valid arguments for one call. May write rows, through the package's own commands. */
  arrange: (ctx: Ctx) => Args | Promise<Args>;
  /** Calls the operation on a real object. */
  call: (ctx: Ctx, ...args: NoInfer<Args>) => unknown;
  /** Checks the valid call's result. Default: it is not a failure. */
  valid?: (result: unknown, ctx: Ctx) => void | Promise<void>;
  /** The result is an object of operations: each must have its own case. */
  surface?: boolean;
  /** Argument paths the walk leaves alone (a dependency, a callback), with the reason. */
  keep?: Record<string, string>;
  timeoutMs?: number;
};

/** Defines the case of one operation. `call` is typed by what `arrange` returns. */
export function op<Ctx, Args extends unknown[]>(key: string, options: OpOptions<Ctx, Args>): HostileCase<Ctx> {
  return {
    op: key,
    async run(ctx, mutate) {
      const args = await options.arrange(ctx);
      const list: unknown[] = [...args];
      mutate(list);
      // The gate's one cast (founder-approved 2026-11-11): handing a mistyped value to a typed function is
      // what this gate is for, and TypeScript allows that only through a cast. The mutated copy keeps the
      // arguments' shape, only with hostile leaves; the valid call in each case stays fully typed.
      const result = await options.call(ctx, ...(list as unknown as Args));
      return { args: list, result };
    },
    valid:
      options.valid ??
      (result => {
        expect(isFailure(result), `valid call returned a failure: ${describeValue(result)}`).toBe(false);
      }),
    surface: options.surface ?? false,
    keep: options.keep ?? {},
    timeoutMs: options.timeoutMs ?? 10_000,
  };
}

/** The arguments of one call, as a tuple: `arrange: () => args(id, { name: 'x' })`. */
export function args<Values extends unknown[]>(...values: Values): Values {
  return values;
}

/** One area of the package: a fixture opened once, and the cases that run on it. */
export type HostileArea<Ctx> = {
  area: string;
  open: () => Promise<Ctx>;
  close?: (ctx: Ctx) => Promise<void>;
  cases: HostileCase<Ctx>[];
  /** Operations of this area that need no case, each with the reason. */
  exempt?: Record<string, string>;
};

/** Defines an area. */
export function area<Ctx>(definition: HostileArea<Ctx>): HostileArea<Ctx> {
  return definition;
}

// ---------------------------------------------------------------- hostile values

const STRINGS: [string, string][] = [
  ["'' (empty)", ''],
  ["'\\u0000'", '\u0000'],
  ["'a\\u0000b'", 'a\u0000b'],
  ["'\\ud800' (lone surrogate)", '\uD800'],
  ['300-char text', 'x'.repeat(300)],
  ['100k-char text', 'x'.repeat(100_000)],
  ["'a\\r\\nb'", 'a\r\nb'],
  ["'éĀ' (above U+00FF)", 'éĀ'],
];

const NUMBERS: [string, number][] = [
  ['1.5', 1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['-1', -1],
  ['2**31', 2 ** 31],
  ['2**53 + 2', 2 ** 53 + 2],
];

const BIG_ARRAY = 200_000;

function tagOf(value: unknown): string {
  return Object.prototype.toString.call(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isMoneyLike(value: Record<string, unknown>): boolean {
  return typeof value.currency === 'string' && (typeof value.amount === 'string' || typeof value.amount === 'number');
}

function pathText(path: PathStep[]): string {
  let text = 'args';
  for (const step of path) text += typeof step === 'number' ? `[${step}]` : `.${step}`;
  return text;
}

/** Every hostile substitution the valid arguments allow, leaf by leaf. */
export function mutationsOf(args: unknown[]): Mutation[] {
  const out: Mutation[] = [];

  function walk(value: unknown, path: PathStep[], seen: Set<unknown>): void {
    if (typeof value === 'string') {
      for (const [label, hostile] of STRINGS) {
        out.push({ path, label, value: () => hostile, slow: hostile.length > 1000 });
      }
      return;
    }
    if (typeof value === 'number') {
      for (const [label, hostile] of NUMBERS) out.push({ path, label, value: () => hostile });
      return;
    }
    if (value instanceof Date) {
      out.push(
        { path, label: 'Date in year 0', value: () => new Date('0000-01-01T00:00:00.000Z') },
        { path, label: 'Date in year 10000', value: () => new Date('+010000-01-01T00:00:00.000Z') },
        { path, label: 'Invalid Date', value: () => new Date(Number.NaN) },
      );
      return;
    }
    if (tagOf(value) === '[object Temporal.Instant]') {
      out.push(
        { path, label: 'Instant in year 0', value: () => instant('0000-01-01T00:00:00Z') },
        { path, label: 'Instant in year 10000', value: () => instant('+010000-01-01T00:00:00Z') },
      );
      return;
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) return;

    if (Array.isArray(value)) {
      if (path.length > 0) {
        out.push({ path, label: 'empty array', value: () => [] });
        if (value.length > 0) {
          out.push({
            path,
            label: `${BIG_ARRAY} items`,
            value: valid => Array.from({ length: BIG_ARRAY }, () => (Array.isArray(valid) ? valid[0] : undefined)),
            slow: true,
          });
        }
      }
      const inner = new Set(seen).add(value);
      for (const [index, item] of value.entries()) walk(item, [...path, index], inner);
      return;
    }

    if (!isPlainObject(value)) return;

    out.push(
      { path, label: 'extra unknown key', value: valid => ({ ...spreadable(valid), hostileExtraKey: 'x' }) },
      { path, label: 'extra bigint field', value: valid => ({ ...spreadable(valid), hostileBigint: 1n }) },
    );
    if (isMoneyLike(value)) {
      out.push(
        {
          path,
          label: 'money finer than the minor unit',
          value: valid => {
            const money = spreadable(valid);
            return { ...money, amount: typeof money.amount === 'number' ? 1.000_01 : '1.00001' };
          },
        },
        { path, label: "money in unknown currency 'QQQ'", value: valid => ({ ...spreadable(valid), currency: 'QQQ' }) },
      );
    }
    const inner = new Set(seen).add(value);
    for (const [key, field] of Object.entries(value)) walk(field, [...path, key], inner);
  }

  for (const [index, arg] of args.entries()) walk(arg, [index], new Set());
  return out;
}

function spreadable(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function readAt(root: unknown[], path: PathStep[]): unknown {
  let current: unknown = root;
  for (const step of path)
    current = current === null || current === undefined ? undefined : Reflect.get(new Object(current), step);
  return current;
}

function writeAt(root: unknown[], path: PathStep[], value: unknown): void {
  const parent = readAt(root, path.slice(0, -1));
  const last = path.at(-1);
  if (last === undefined || typeof parent !== 'object' || parent === null) return;
  Reflect.set(parent, last, value);
}

// ---------------------------------------------------------------- outcomes

/** What went wrong, short: the class, a SQLSTATE or code when there is one, and the message. */
export function describeError(error: unknown): { kind: string; message: string } {
  if (!(error instanceof Error)) return { kind: `thrown ${typeof error}`, message: describeValue(error) };
  const name = error.constructor.name || error.name;
  const cause: unknown = error.cause;
  const sqlstate = cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : undefined;
  const code = 'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const kind = sqlstate ? `${name} (SQLSTATE ${sqlstate})` : code ? `${name} (${code})` : name;
  const message = (cause instanceof Error ? `${error.message} <- ${cause.message}` : error.message)
    .replaceAll(/x{40,}/gi, 'x…')
    .slice(0, 300);
  return { kind, message };
}

function describeValue(value: unknown): string {
  try {
    const text: unknown = JSON.stringify(value, (_key, field: unknown) =>
      typeof field === 'bigint' ? `${field}n` : field,
    );
    return (typeof text === 'string' ? text : String(value)).slice(0, 200);
  } catch {
    return String(value);
  }
}

class Hang extends Error {}

/** The call a database query belongs to; set to cancelled when that call ran past its time limit. */
const currentCall = new AsyncLocalStorage<{ cancelled: boolean }>();

/**
 * Lets a time limit fire while PGlite works. PGlite answers a query in
 * microtasks, so an operation looping over 200,000 inputs never gives a timer
 * a turn and the whole area hangs. Each query of the fixture's client first
 * waits one event-loop turn, and a query of a call that is already past its
 * limit is refused, so the runaway stops instead of starving the next cases.
 */
function paceQueries(ctx: unknown): void {
  for (const client of Object.values(new Object(ctx))) {
    if (!(client instanceof PGlite)) continue;
    for (const name of ['query', 'exec', 'transaction'] as const) {
      const original: unknown = Reflect.get(client, name);
      if (typeof original !== 'function') continue;
      Object.defineProperty(client, name, {
        configurable: true,
        value: async (...rest: unknown[]) => {
          await new Promise(resolve => setImmediate(resolve));
          if (currentCall.getStore()?.cancelled) throw new Hang('the call ran past its time limit');
          return Reflect.apply(original, client, rest);
        },
      });
    }
  }
}

function withLimit<T>(call: () => Promise<T>, ms: number): Promise<T> {
  const state = { cancelled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      state.cancelled = true;
      reject(new Hang(`no answer within ${ms} ms`));
    }, ms);
  });
  return Promise.race([currentCall.run(state, call), limit]).finally(() => clearTimeout(timer));
}

/** One failing case, as the report and the fixers see it. */
export type HostileFailure = {
  area: string;
  op: string;
  path: string;
  hostile: string;
  kind: string;
  message: string;
};

/** Where an area's failing cases are written, one JSON line each (`.cache/` is git-ignored). */
export const reportDir = `${srcDir}../.cache/hostile-input/`;

function record(failure: HostileFailure): void {
  appendFileSync(`${reportDir}${failure.area}.jsonl`, `${JSON.stringify(failure)}\n`);
}

/** Founder rule (2026-11-09): failures are returned, never thrown; the one allowed throw is a documented `invariant`. */
function allowed(error: unknown): boolean {
  return error instanceof FailureError && error.code === FAILURE_ERROR_CODES.invariant;
}

// ---------------------------------------------------------------- runner

/** The mutation of the valid call: none. */
function keepValid(): void {
  // The valid call runs on the arguments as arranged.
}

/** Registers one vitest test per operation of the area. */
export function runArea<Ctx>(definition: HostileArea<Ctx>): void {
  describe(`hostile input: ${definition.area}`, () => {
    let ctx: Ctx | undefined;
    const keys = new Set(definition.cases.map(entry => entry.op));

    beforeAll(async () => {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(`${reportDir}${definition.area}.jsonl`, '');
      ctx = await definition.open();
      paceQueries(ctx);
    }, 120_000);

    afterAll(async () => {
      if (ctx !== undefined) await definition.close?.(ctx);
    });

    test('every case names a distinct operation', () => {
      const counts = new Map<string, number>();
      for (const entry of definition.cases) counts.set(entry.op, (counts.get(entry.op) ?? 0) + 1);
      expect([...counts].filter(([, count]) => count > 1).map(([key]) => key)).toEqual([]);
    });

    for (const entry of definition.cases) {
      test(
        entry.op,
        async () => {
          if (ctx === undefined) throw new Error(`the ${definition.area} fixture did not open`);
          const fixture = ctx;
          const failures: HostileFailure[] = [];
          const fail = (path: string, hostile: string, error: unknown) => {
            const failure = { area: definition.area, op: entry.op, path, hostile, ...describeError(error) };
            failures.push(failure);
            record(failure);
          };

          // 1. The valid call must succeed, so a broken arrangement cannot hide behind "every mutation was refused".
          let validArgs: unknown[];
          try {
            const { args, result } = await withLimit(() => entry.run(fixture, keepValid), entry.timeoutMs);
            await entry.valid(result, fixture);
            validArgs = args;
            if (entry.surface) {
              const missing = Object.entries(new Object(result))
                .filter(([, value]) => typeof value === 'function')
                .map(([name]) => `${entry.op}().${name}`)
                .filter(name => !keys.has(name));
              expect(missing, 'operations on the returned object without a case').toEqual([]);
            }
          } catch (error) {
            fail('(valid call)', '(none)', error);
            throw error;
          }

          // 2. Every hostile value at every leaf.
          for (const mutation of mutationsOf(validArgs)) {
            const path = pathText(mutation.path);
            if (
              Object.keys(entry.keep).some(
                kept => path === kept || path.startsWith(`${kept}.`) || path.startsWith(`${kept}[`),
              )
            ) {
              continue;
            }
            try {
              await withLimit(
                () =>
                  entry.run(fixture, args => writeAt(args, mutation.path, mutation.value(readAt(args, mutation.path)))),
                mutation.slow ? Math.max(entry.timeoutMs, 30_000) : entry.timeoutMs,
              );
            } catch (error) {
              if (!allowed(error)) fail(path, mutation.label, error);
            }
          }

          expect(
            failures.map(failure => `${failure.path} = ${failure.hostile} → ${failure.kind}: ${failure.message}`),
            `${entry.op}: hostile inputs that ended in an undocumented error`,
          ).toEqual([]);
        },
        1_800_000,
      );
    }
  });
}
