/**
 * Runs a suite and returns a result. Portable: no host APIs, prints nothing.
 *
 * Protocol (from the Fable + Astra review):
 * 1. Validate the suite, apply the filter.
 * 2. Contract check: every compare-group case that keeps the contract runs on
 *    every input (untimed) and must produce the oracle's value (or the
 *    baseline's). The oracle and every case get their own copy of each input.
 *    A failing group is not timed.
 * 3. Measurement with mitata's `measure()`: each case gets its own generated
 *    timed function (its own call site and type feedback, so no case is
 *    favoured by running first), states are prepared once and untimed, the
 *    timed function cycles through them, and every result goes to mitata's
 *    `do_not_optimize` sink.
 * 4. Interleaved randomized blocks: after a time-based warm-up, each round
 *    times one block per case in a seeded random order, so drift (thermal,
 *    load, GC pressure) spreads over every case instead of hitting one.
 * 5. An empty-function floor, measured like a case, exposes cases whose work
 *    was optimized away.
 * 6. After timing, each ranked case runs once more on the states it was timed
 *    on; a different answer means run() changed its input (`state-mutated`).
 * 7. `assessResult` derives flags, warnings and `publishable` from the data.
 *
 * A block is ONE mitata `measure` call with a CPU-time budget. Its
 * `ns / ops` is exactly mitata's `avg`: mitata times samples (one call, or a
 * batch of 4096 calls for work under 65 µs), sorts them, drops the 2 fastest
 * and 2 slowest when it has more than 12, and reports the mean per-op time of
 * the rest; `ticks` is the number of operations in the kept samples. So
 * `ops = ticks` and `ns = avg × ticks` (the time those operations took).
 */
import { do_not_optimize, measure } from 'mitata';

import type {
  BenchResult,
  Block,
  Budget,
  CaseResult,
  CaseRole,
  CompareSpec,
  Comparison,
  ContractCheck,
  Environment,
  Flag,
  GroupResult,
  GroupSpec,
  MetricSpec,
  Mode,
  Profile,
  ProgressEvent,
  RunOptions,
  ScenarioSpec,
  SizeSpec,
  SuiteSpec,
  Summary,
  Warning,
} from './types.js';
import { SpecError, specHash, validateSuite, workHash } from './spec.js';
import {
  compareBlocks,
  compareMedians,
  createRandom,
  DEFAULT_SEED,
  exactComparison,
  summarize,
  summarizeValues,
} from './stats.js';
import { MITATA_VERSION, VERSION } from './version.js';
import { BLOCKING_WARNINGS } from './warnings.js';

/**
 * Measurement budget per profile.
 * - quick: 1 round of 10 ms blocks after a 10 ms warm-up. Smoke test only; never publishable.
 * - explore: 10 rounds × 100 ms blocks ≈ 1 s per case, after a 100 ms warm-up. Unstable above cv 10%.
 * - publish: the same per process (the host runs several fresh processes). Unstable above cv 5%.
 */
export const PROFILE_BUDGETS: Readonly<Record<Profile, Budget>> = {
  quick: { rounds: 1, blockMs: 10, warmupMs: 10, minSamples: 2, maxCv: Number.POSITIVE_INFINITY, metricRepeats: 2 },
  explore: { rounds: 10, blockMs: 100, warmupMs: 100, minSamples: 4, maxCv: 0.1, metricRepeats: 10 },
  publish: { rounds: 10, blockMs: 100, warmupMs: 100, minSamples: 4, maxCv: 0.05, metricRepeats: 10 },
};

/**
 * A case is `optimized-out` when its fastest block is no more than
 * max(OPTIMIZED_OUT_MARGIN_NS, OPTIMIZED_OUT_MARGIN_RATIO × floor's fastest
 * block) above the floor's fastest block: the work is then indistinguishable
 * from calling an empty function. Fastest blocks, not estimates, intervals or
 * medians: interference (preemption, other load) only ever adds time, so the
 * fastest block is the closest view of the real cost, while one preempted
 * block on a busy machine inflates a Σns/Σops interval many times over and
 * would flag real work (or hide a dropped body).
 */
export const OPTIMIZED_OUT_MARGIN_NS = 1;
export const OPTIMIZED_OUT_MARGIN_RATIO = 0.2;

/**
 * The floor is an empty function plus the state cycling every case pays. Its
 * fastest block costs a few ns on a JIT and tens of ns on an interpreter
 * (Hermes). Above this limit the floor itself was disturbed (preemption), so
 * it cannot tell real work from a dropped body: no case is flagged against it,
 * and the group gets a `floor-unreliable` warning that blocks publishing.
 */
export const FLOOR_TRUST_LIMIT_NS = 100;

/** Optimized-out detection needs the fastest of at least this many floor blocks. */
export const MIN_FLOOR_BLOCKS = 3;

const DEFAULT_TIMEOUT_MS = 10_000;
const SPEED_UNIT = 'ns/op';

// ---------------------------------------------------------------------------
// Host globals (read through globalThis: the core has no host imports)
// ---------------------------------------------------------------------------

type HostGlobals = {
  Bun?: { version?: string; gc?: (force: boolean) => void };
  Deno?: { version?: { deno?: string } };
  HermesInternal?: { getRuntimeProperties?: () => Readonly<Record<string, unknown>> };
  process?: { versions?: { node?: string } };
  navigator?: { userAgent?: string };
  gc?: () => void;
  structuredClone?: (value: unknown) => unknown;
};

const host: HostGlobals = globalThis;

function detectRuntime(): Environment['runtime'] {
  const deno = host.Deno?.version?.deno;
  if (deno) return { name: 'deno', version: deno };
  const bun = host.Bun?.version;
  if (bun) return { name: 'bun', version: bun };
  if (host.HermesInternal) {
    const version = host.HermesInternal.getRuntimeProperties?.()['OSS Release Version'];
    return { name: 'hermes', version: typeof version === 'string' ? version : 'unknown' };
  }
  const node = host.process?.versions?.node;
  if (node) return { name: 'node', version: node };
  const agent = host.navigator?.userAgent;
  if (agent) return { name: 'browser', version: agent };
  return { name: 'unknown', version: 'unknown' };
}

/**
 * A real collector when the runtime exposes one (Bun, `node --expose-gc`).
 * mitata's own fallback allocates a 1 GiB buffer to provoke a collection; per
 * block that is too costly, so without a real collector blocks start without
 * forcing GC (GC that happens during a block is part of the work's cost).
 */
function realGc(): (() => void) | undefined {
  if (typeof host.Bun?.gc === 'function') return () => host.Bun?.gc?.(true);
  const gc = host.gc;
  if (typeof gc === 'function') return () => gc();
  return undefined;
}

// ---------------------------------------------------------------------------
// Values: equality and display for the contract check
// ---------------------------------------------------------------------------

/** Does deepEqual compare this object by content? Anything else is equal only to itself. */
function isComparable(value: object): boolean {
  if (typeof value === 'function') return false;
  if (Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype === null || prototype === Object.prototype) return true;
  if (
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof Map ||
    value instanceof Set ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value)
  ) {
    return true;
  }
  // A class instance is compared by its own enumerable data; with none (a
  // Promise, a WeakMap, an object keeping its state in private fields) there
  // is nothing to compare, and calling two of them equal would pass any case.
  return Object.keys(value).length > 0;
}

const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' && value !== null) || typeof value === 'function';

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (const [index, byte] of left.entries()) if (byte !== right[index]) return false;
  return true;
}

const viewBytes = (view: ArrayBufferView): Uint8Array => new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/** What a failed comparison learned: the first value it could not compare, for the failure text. */
type EqualityNote = { incomparable?: unknown };

/**
 * `path` holds the pairs on the current recursion path (cycles compare
 * equal). A pair leaves it when its comparison ends, so a failed attempt
 * (e.g. while searching a Set for a match) never makes a later one pass.
 */
function equal(a: unknown, b: unknown, path: [object, object][], note: EqualityNote): boolean {
  if (Object.is(a, b)) return true;
  if (!isObjectLike(a) || !isObjectLike(b)) {
    const object = isObjectLike(a) ? a : isObjectLike(b) ? b : undefined;
    if (object !== undefined && !isComparable(object)) note.incomparable ??= object;
    return false;
  }
  if (!isComparable(a) || !isComparable(b)) {
    note.incomparable ??= isComparable(a) ? b : a;
    return false;
  }
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (path.some(([left, right]) => left === a && right === b)) return true;
  path.push([a, b]);
  try {
    return equalContents(a, b, path, note);
  } finally {
    path.pop();
  }
}

/** Two comparable objects with the same prototype. */
function equalContents(a: object, b: object, seen: [object, object][], note: EqualityNote): boolean {
  if (a instanceof Date) return b instanceof Date && Object.is(a.getTime(), b.getTime());
  if (a instanceof RegExp) return b instanceof RegExp && a.source === b.source && a.flags === b.flags;
  if (a instanceof Error) return b instanceof Error && a.name === b.name && a.message === b.message;
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    // One-to-one: each entry of b matches at most one entry of a.
    const used = new Set<unknown>();
    const pending: [unknown, unknown][] = [];
    for (const [key, value] of a) {
      if (b.has(key) && equal(value, b.get(key), seen, note)) used.add(key);
      else pending.push([key, value]);
    }
    for (const [key, value] of pending) {
      let found = false;
      for (const [otherKey, otherValue] of b) {
        if (used.has(otherKey) || !equal(key, otherKey, seen, note) || !equal(value, otherValue, seen, note)) continue;
        used.add(otherKey);
        found = true;
        break;
      }
      if (!found) return false;
    }
    return true;
  }
  if (a instanceof Set) {
    if (!(b instanceof Set) || a.size !== b.size) return false;
    // One-to-one: identical members pair first, then each remaining member takes one unused equal member.
    const used = new Set<unknown>();
    const pending: unknown[] = [];
    for (const value of a) {
      if (b.has(value)) used.add(value);
      else pending.push(value);
    }
    for (const value of pending) {
      let found = false;
      for (const other of b) {
        if (used.has(other) || !equal(value, other, seen, note)) continue;
        used.add(other);
        found = true;
        break;
      }
      if (!found) return false;
    }
    return true;
  }
  if (a instanceof ArrayBuffer) return b instanceof ArrayBuffer && sameBytes(new Uint8Array(a), new Uint8Array(b));
  if (ArrayBuffer.isView(a)) return ArrayBuffer.isView(b) && sameBytes(viewBytes(a), viewBytes(b));
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (const [index, item] of a.entries()) {
      if (!equal(item, b[index], seen, note)) return false;
    }
    return true;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!equal(Reflect.get(a, key), Reflect.get(b, key), seen, note)) return false;
  }
  return true;
}

/**
 * Deep, stable equality for normalized values. Primitives compare with
 * `Object.is` (NaN equals NaN, -0 differs from 0, bigint by value). Objects
 * must share a prototype. Date compares by time, RegExp by source and flags,
 * Error by name and message, ArrayBuffer, typed arrays and DataView by bytes,
 * Map and Set one-to-one (each entry is used once), arrays, plain objects and
 * class instances by their own enumerable keys. Anything else (functions,
 * Promise, WeakMap, an instance with no own enumerable data) is not
 * comparable: it is equal only to itself.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  return equal(a, b, [], {});
}

/** deepEqual, plus the first value it could not compare when that is why it failed. */
function compareValues(a: unknown, b: unknown): { equal: boolean; incomparable?: unknown } {
  const note: EqualityNote = {};
  if (equal(a, b, [], note)) return { equal: true };
  return 'incomparable' in note ? { equal: false, incomparable: note.incomparable } : { equal: false };
}

const MAX_SHOWN = 300;

/** Readable one-line rendering of a value for check failures (`1n`, `-0`, `Map(1) { "a" => 1 }`…). */
export function formatValue(value: unknown): string {
  const text = show(value, 0, []);
  return text.length > MAX_SHOWN ? `${text.slice(0, MAX_SHOWN - 1)}…` : text;
}

function show(value: unknown, depth: number, stack: object[]): string {
  switch (typeof value) {
    case 'string': {
      return JSON.stringify(value);
    }
    case 'number': {
      return Object.is(value, -0) ? '-0' : String(value);
    }
    case 'bigint': {
      return `${value}n`;
    }
    case 'function': {
      return `[Function ${value.name || 'anonymous'}]`;
    }
    case 'object': {
      break;
    }
    default: {
      return String(value);
    }
  }
  if (value === null) return 'null';
  if (stack.includes(value)) return '[Circular]';
  if (depth > 4) return '…';
  if (value instanceof Date) return `Date(${Number.isNaN(value.getTime()) ? 'Invalid' : value.toISOString()})`;
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  stack.push(value);
  try {
    const inner = (item: unknown): string => show(item, depth + 1, stack);
    if (value instanceof Map) {
      const entries = [...value].map(([key, item]) => `${inner(key)} => ${inner(item)}`);
      return `Map(${value.size}) {${entries.length > 0 ? ` ${entries.join(', ')} ` : ''}}`;
    }
    if (value instanceof Set) {
      const items = [...value].map(item => inner(item));
      return `Set(${value.size}) {${items.length > 0 ? ` ${items.join(', ')} ` : ''}}`;
    }
    if (ArrayBuffer.isView(value)) {
      const bytes = [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
      return `${value.constructor.name}(${value.byteLength} bytes) [${bytes.join(', ')}]`;
    }
    if (Array.isArray(value)) return `[${value.map(item => inner(item)).join(', ')}]`;
    const prototype: unknown = Object.getPrototypeOf(value);
    const name = prototype === null || prototype === Object.prototype ? '' : `${value.constructor.name} `;
    const fields = Object.keys(value).map(key => `${JSON.stringify(key)}: ${inner(Reflect.get(value, key))}`);
    return `${name}{${fields.length > 0 ? ` ${fields.join(', ')} ` : ''}}`;
  } finally {
    stack.pop();
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : formatValue(error);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function withTimeout<T>(promise: PromiseLike<T>, ms: number, message: () => string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message())), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

/** FNV-1a of a label mixed into the run seed: each group (and process) gets its own block order. */
function mixSeed(seed: number, label: string): number {
  let hash = (seed ^ 2_166_136_261) >>> 0; // FNV offset basis 0x811C9DC5
  for (let index = 0; index < label.length; index++) {
    hash ^= label.codePointAt(index) ?? 0;
    hash = Math.imul(hash, 16_777_619) >>> 0; // FNV prime 0x01000193
  }
  return hash;
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy;
}

function matches(filter: string | RegExp, text: string): boolean {
  if (typeof filter === 'string') return text.includes(filter);
  filter.lastIndex = 0;
  return filter.test(text);
}

function pick<T>(cases: Readonly<Record<string, T>>, keys: readonly string[]): Record<string, T> {
  const picked: Record<string, T> = {};
  for (const key of keys) picked[key] = cases[key]!;
  return picked;
}

/** The group with only the cases the filter selects (the baseline is kept so ratios and the check still work). */
function selectGroup(group: GroupSpec, filter: string | RegExp | undefined): GroupSpec | undefined {
  if (filter === undefined || matches(filter, group.id)) return group;
  const keys = Object.keys(group.cases).filter(key => matches(filter, `${group.id}/${key}`));
  if (keys.length === 0) return undefined;
  if (group.kind !== 'scenario' && !keys.includes(group.baseline)) keys.unshift(group.baseline);
  switch (group.kind) {
    case 'scenario': {
      return { ...group, cases: pick(group.cases, keys) };
    }
    case 'size': {
      return { ...group, cases: pick(group.cases, keys) };
    }
    case 'metric': {
      return { ...group, cases: pick(group.cases, keys) };
    }
    default: {
      return { ...group, cases: pick(group.cases, keys) };
    }
  }
}

function checkBudget(budget: Budget): void {
  const problems: string[] = [];
  if (!Number.isInteger(budget.rounds) || budget.rounds < 1) problems.push('budget.rounds must be an integer ≥ 1.');
  if (!(budget.blockMs > 0)) problems.push('budget.blockMs must be > 0.');
  if (!(budget.warmupMs >= 0)) problems.push('budget.warmupMs must be ≥ 0.');
  if (!Number.isInteger(budget.minSamples) || budget.minSamples < 1) {
    problems.push('budget.minSamples must be an integer ≥ 1.');
  }
  if (!(budget.maxCv > 0)) problems.push('budget.maxCv must be > 0.');
  if (!Number.isInteger(budget.metricRepeats) || budget.metricRepeats < 1) {
    problems.push('budget.metricRepeats must be an integer ≥ 1.');
  }
  if (problems.length > 0) throw new RangeError(problems.join(' '));
}

// ---------------------------------------------------------------------------
// Timed functions and blocks
// ---------------------------------------------------------------------------

type Runnable = { run(state: unknown): unknown };
type TimedFactory = (target: Runnable, states: readonly unknown[], sink: (value: unknown) => void) => () => unknown;

const isTimedFactory = (value: unknown): value is TimedFactory => typeof value === 'function';

// Both bodies are identical for every case and for the floor, so the cycling
// and sink overhead is the same everywhere. A compare-and-reset is used
// instead of `%` (cheaper; same cost for all).
const SYNC_BODY = `let k = -1; const n = states.length;
return function timed() { k = k + 1 === n ? 0 : k + 1; sink(target.run(states[k])); };`;
const ASYNC_BODY = `let k = -1; const n = states.length;
return async function timed() { k = k + 1 === n ? 0 : k + 1; sink(await target.run(states[k])); };`;

/**
 * Builds a fresh timed function for one case. It must be NEW code per case,
 * not a closure from one shared literal: V8 shares type feedback between
 * closures of the same literal, so a shared `target.run(...)` call site turns
 * polymorphic after the first case and favours it (review point D1). mitata
 * generates its measuring loop the same way.
 */
function createTimed(mode: Mode, target: Runnable, states: readonly unknown[]): () => unknown {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- per-case code generation is the point (see above); the body is a constant, never user input
  const factory: unknown = new Function('target', 'states', 'sink', mode === 'async' ? ASYNC_BODY : SYNC_BODY);
  if (!isTimedFactory(factory)) throw new TypeError('Function constructor did not return a function.');
  return factory(target, states, do_not_optimize);
}

let sinkPrepared = false;

/**
 * mitata's sink stores into one shared object field. Storing a number, then
 * an object, generalizes that field's representation and deoptimizes code
 * compiled for the narrower one, which would penalize whichever case ran
 * first. Storing every kind once up front settles the field before timing.
 */
function prepareSink(): void {
  if (sinkPrepared) return;
  for (const value of [0, 0.5, 'x', {}, [], 1n, true, undefined, null, Symbol('sink')]) do_not_optimize(value);
  do_not_optimize(0);
  sinkPrepared = true;
}

type BlockContext = {
  mode: Mode;
  budget: Budget;
  timeoutMs: number;
  gc: (() => void) | undefined;
  where: string;
};

async function timeBlock(
  timed: () => unknown,
  ms: number,
  context: BlockContext,
): Promise<{ ns: number; ops: number }> {
  const pending = measure(
    function* () {
      yield timed;
    },
    { min_cpu_time: ms * 1e6, min_samples: context.budget.minSamples, gc: context.gc ?? false },
  );
  let stats: Awaited<typeof pending>;
  try {
    // Watchdog: async work can hang forever. A block may take its budget plus
    // up to (minSamples + 3 warm-up calls) calls of `timeoutMs` each.
    stats =
      context.mode === 'async'
        ? await withTimeout(
            pending,
            2 * ms + (context.budget.minSamples + 3) * context.timeoutMs,
            () => `${context.where}: a timed block did not finish (timeoutMs is ${context.timeoutMs}).`,
          )
        : await pending;
  } catch (error) {
    throw new Error(`${context.where} failed while timing: ${describeError(error)}`, { cause: error });
  }
  return { ns: stats.avg * stats.ticks, ops: stats.ticks };
}

// ---------------------------------------------------------------------------
// Inputs: a pristine copy for every use
// ---------------------------------------------------------------------------

/** Does `copy` keep the prototype of every object in `original`? structuredClone turns class instances into plain objects. */
function samePrototypes(original: unknown, copy: unknown, seen: Set<object>): boolean {
  if (typeof original !== 'object' || original === null) return true;
  if (typeof copy !== 'object' || copy === null) return false;
  if (seen.has(original)) return true;
  seen.add(original);
  if (Object.getPrototypeOf(original) !== Object.getPrototypeOf(copy)) return false;
  if (original instanceof ArrayBuffer || ArrayBuffer.isView(original)) return true;
  if (original instanceof Map && copy instanceof Map) {
    const copied = [...copy];
    return [...original].every(
      ([key, value], index) =>
        samePrototypes(key, copied[index]?.[0], seen) && samePrototypes(value, copied[index]?.[1], seen),
    );
  }
  if (original instanceof Set && copy instanceof Set) {
    const copied = [...copy];
    return [...original].every((value, index) => samePrototypes(value, copied[index], seen));
  }
  return Object.keys(original).every(key => samePrototypes(Reflect.get(original, key), Reflect.get(copy, key), seen));
}

/** Hands out an input for one use: a fresh copy, or the shared original when copies are not possible. */
type InputCopies = { fresh: (index: number) => unknown };

/**
 * Every use of an input (the oracle, each case's check, each case's timed
 * states) gets its own `structuredClone`, so a case that mutates its input
 * cannot change what the oracle or another case sees. A copy must keep every
 * prototype (structuredClone turns class instances into plain objects, which
 * would change the work). When some input cannot be copied that way, or the
 * runtime has no structuredClone (Hermes), every use gets the original and
 * the group gets a non-blocking `inputs-shared` warning.
 */
function inputCopies(group: string, inputs: readonly unknown[], warnings: Warning[]): InputCopies {
  const clone = host.structuredClone;
  let problem = typeof clone === 'function' ? undefined : 'this runtime has no structuredClone';
  if (clone) {
    for (const [index, input] of inputs.entries()) {
      try {
        if (samePrototypes(input, clone(input), new Set())) continue;
        problem = `input #${index} holds an object a copy would not keep (a class instance or a null-prototype object)`;
      } catch (error) {
        problem = `input #${index} cannot be copied with structuredClone (${describeError(error)})`;
      }
      break;
    }
  }
  if (!clone || problem !== undefined) {
    warnings.push({
      code: 'inputs-shared',
      group,
      message: `Every case of "${group}" and its oracle share the same input objects: ${problem ?? 'they cannot be copied'}. A case that changes its input can change what the others see. Use plain-data inputs and build objects in setup().`,
    });
    return { fresh: index => inputs[index] };
  }
  return { fresh: index => clone(inputs[index]) };
}

// ---------------------------------------------------------------------------
// Contract check
// ---------------------------------------------------------------------------

type CaseLike = {
  setup?(input: unknown): unknown;
  run(state: unknown): unknown;
  normalize?(result: unknown): unknown;
  teardown?(state: unknown): unknown;
};

type Outcome = { ok: true; value: unknown } | { ok: false; error: string };

function asyncMisuse(group: string, key: string): string {
  return `Group "${group}", case "${key}": run() returned a promise, but the group runs in sync mode, so only the synchronous start of the work would be timed. Set \`mode: 'async'\` on the group.`;
}

/** Untimed: the state `run` receives for one input. setup() must be synchronous. */
function makeState(group: string, key: string, spec: CaseLike, input: unknown): unknown {
  if (!spec.setup) return input;
  const state = spec.setup(input);
  if (isThenable(state)) {
    throw new SpecError([
      `Group "${group}", case "${key}": setup() returned a promise; setup is synchronous — open async resources at module load or in a top-level await.`,
    ]);
  }
  return state;
}

/** run → (await in async mode) → normalize (awaited), untimed. */
async function runOnce(group: string, key: string, spec: CaseLike, state: unknown, mode: Mode, timeoutMs: number) {
  let result = spec.run(state);
  if (isThenable(result)) {
    if (mode !== 'async') throw new SpecError([asyncMisuse(group, key)]);
    result = await withTimeout(result, timeoutMs, () => `timed out after ${timeoutMs} ms`);
  }
  return spec.normalize ? await spec.normalize(result) : result;
}

/**
 * setup → run → normalize → teardown, untimed. Misuse throws; the case's own
 * errors become an outcome. A teardown error fails the outcome too, and is
 * reported next to a run error rather than hiding it.
 */
async function callCase(
  group: string,
  key: string,
  spec: CaseLike,
  input: unknown,
  mode: Mode,
  timeoutMs: number,
): Promise<Outcome> {
  let outcome: Outcome;
  let state: unknown;
  let ready = false;
  try {
    state = makeState(group, key, spec, input);
    ready = true;
    outcome = { ok: true, value: await runOnce(group, key, spec, state, mode, timeoutMs) };
  } catch (error) {
    if (error instanceof SpecError) throw error;
    outcome = { ok: false, error: describeError(error) };
  }
  if (ready && spec.teardown) {
    try {
      await spec.teardown(state);
    } catch (error) {
      const teardown = `teardown: ${describeError(error)}`;
      outcome = { ok: false, error: outcome.ok ? teardown : `${outcome.error}; ${teardown}` };
    }
  }
  return outcome;
}

/** The failure text for a value that differs from the reference. */
function mismatchText(actual: unknown, incomparable: unknown): string {
  const shown = formatValue(actual);
  if (incomparable === undefined) return shown;
  return `${shown} (not comparable: ${formatValue(incomparable)} has no data the check can compare; map the result to plain data with \`normalize\`)`;
}

async function checkContract(
  group: CompareSpec<unknown>,
  mode: Mode,
  timeoutMs: number,
  copies: InputCopies,
): Promise<{ check: ContractCheck; references: readonly Outcome[] }> {
  const failures: { case: string; input: number; expected: string; actual: string }[] = [];
  const ranked = Object.keys(group.cases).filter(key => group.cases[key]!.differs === undefined);

  // The oracle runs first, on pristine copies: no case can have changed what it is given.
  const oracle: Outcome[] = [];
  if (group.expected) {
    for (let index = 0; index < group.inputs.length; index++) {
      try {
        oracle.push({ ok: true, value: group.expected(copies.fresh(index)) });
      } catch (error) {
        oracle.push({ ok: false, error: describeError(error) });
      }
    }
  }

  const references: Outcome[] = [];
  for (let index = 0; index < group.inputs.length; index++) {
    const outcomes = new Map<string, Outcome>();
    for (const key of ranked) {
      outcomes.set(key, await callCase(group.id, key, group.cases[key]!, copies.fresh(index), mode, timeoutMs));
    }
    const reference = group.expected ? oracle[index]! : outcomes.get(group.baseline)!;
    if (group.expected && !reference.ok) {
      failures.push({ case: '(expected)', input: index, expected: 'a value', actual: `threw ${reference.error}` });
    }
    references.push(reference);

    for (const key of ranked) {
      const outcome = outcomes.get(key)!;
      const expected = reference.ok ? formatValue(reference.value) : '(no reference value)';
      if (!outcome.ok) {
        failures.push({ case: key, input: index, expected, actual: `threw ${outcome.error}` });
      } else if (reference.ok) {
        const compared = compareValues(outcome.value, reference.value);
        if (!compared.equal) {
          failures.push({
            case: key,
            input: index,
            expected,
            actual: mismatchText(outcome.value, compared.incomparable),
          });
        }
      }
    }
  }
  return {
    check: { status: failures.length === 0 ? 'passed' : 'failed', inputs: group.inputs.length, failures },
    references,
  };
}

/** Runs cases the contract check skips (differs, scenarios) once per input: catches async misuse and throwing work before timing. */
async function probe(
  group: string,
  key: string,
  spec: CaseLike,
  inputs: number,
  copies: InputCopies,
  mode: Mode,
  timeoutMs: number,
): Promise<void> {
  for (let index = 0; index < inputs; index++) {
    const outcome = await callCase(group, key, spec, copies.fresh(index), mode, timeoutMs);
    if (!outcome.ok) throw new Error(`Group "${group}", case "${key}" failed on input ${index}: ${outcome.error}`);
  }
}

// ---------------------------------------------------------------------------
// Speed groups
// ---------------------------------------------------------------------------

/** Flags for one speed case: `optimized-out` against the floor, `unstable` above the cv limit. */
export function caseFlags(summary: Summary, floor: Summary | undefined, maxCv: number): Flag[] {
  const flags: Flag[] = [];
  if (
    floor &&
    // The rule compares fastest blocks; one block (a quick run) has no "fastest of several".
    floor.n >= MIN_FLOOR_BLOCKS &&
    floor.min <= FLOOR_TRUST_LIMIT_NS &&
    summary.min - floor.min <= Math.max(OPTIMIZED_OUT_MARGIN_NS, OPTIMIZED_OUT_MARGIN_RATIO * floor.min)
  ) {
    flags.push('optimized-out');
  }
  if (summary.n > 1 && summary.cv > maxCv) flags.push('unstable');
  return flags;
}

type Prepared = { key: string; spec: CaseLike; states: unknown[] };

type SpeedEntry = { key?: string; timed: () => unknown; blocks: Block[] };

type RunContext = {
  seed: number;
  process: number;
  budget: Budget;
  timeoutMs: number;
  gc: (() => void) | undefined;
  progress: (event: ProgressEvent) => void;
  warnings: Warning[];
};

/** Compare groups: the check's reference value per input, and the cases that keep the contract. */
type Verification = { references: readonly Outcome[]; ranked: ReadonlySet<string> };

const FLOOR: Runnable = {
  run(state: unknown): unknown {
    return state;
  },
};

/**
 * After timing, runs a ranked case once more on each state it was timed on.
 * The answer must still be the reference value: a run() that changed its
 * state (sorted it in place, drained it, cached into it) timed different
 * work than the check verified.
 */
async function stateChange(
  group: string,
  prepared: Prepared,
  references: readonly Outcome[],
  mode: Mode,
  timeoutMs: number,
): Promise<string | undefined> {
  for (const [index, state] of prepared.states.entries()) {
    const reference = references[index];
    if (!reference?.ok) continue;
    let value: unknown;
    try {
      value = await runOnce(group, prepared.key, prepared.spec, state, mode, timeoutMs);
    } catch (error) {
      return `on input #${index} it now throws ${describeError(error)}`;
    }
    if (!deepEqual(value, reference.value)) {
      return `on input #${index} it now returns ${formatValue(value)}, expected ${formatValue(reference.value)}`;
    }
  }
  return undefined;
}

async function measureSpeed(
  group: CompareSpec<unknown> | ScenarioSpec<unknown>,
  inputs: number,
  copies: InputCopies,
  mode: Mode,
  context: RunContext,
  verification?: Verification,
): Promise<{ blocks: ReadonlyMap<string, readonly Block[]>; floor: Summary; floorBlocks: readonly Block[] }> {
  const prepared: Prepared[] = [];
  try {
    // States are created inside the try: when a later setup throws, the earlier states are still torn down.
    for (const [key, spec] of Object.entries(group.cases)) {
      const states: unknown[] = [];
      prepared.push({ key, spec, states });
      for (let index = 0; index < inputs; index++) states.push(makeState(group.id, key, spec, copies.fresh(index)));
    }
    const entries: SpeedEntry[] = prepared.map(({ key, spec, states }) => ({
      key,
      timed: createTimed(mode, spec, states),
      blocks: [],
    }));
    // The floor cycles through its own copies, so reaching a state costs it what it costs a case.
    const floorStates = Array.from({ length: inputs }, (_, index) => copies.fresh(index));
    entries.push({ timed: createTimed(mode, FLOOR, floorStates), blocks: [] });

    const random = createRandom(mixSeed(context.seed, `${context.process}/${group.id}`));
    const blockContext = (entry: SpeedEntry): BlockContext => ({
      mode,
      budget: context.budget,
      timeoutMs: context.timeoutMs,
      gc: context.gc,
      where: `Group "${group.id}", ${entry.key === undefined ? 'empty-function floor' : `case "${entry.key}"`}`,
    });

    if (context.budget.warmupMs > 0) {
      for (const entry of shuffle(entries, random))
        await timeBlock(entry.timed, context.budget.warmupMs, blockContext(entry));
    }
    for (let round = 0; round < context.budget.rounds; round++) {
      for (const entry of shuffle(entries, random)) {
        const { ns, ops } = await timeBlock(entry.timed, context.budget.blockMs, blockContext(entry));
        entry.blocks.push({ process: context.process, block: round, ns, ops });
        if (entry.key !== undefined) {
          context.progress({
            type: 'measure',
            group: group.id,
            case: entry.key,
            block: round + 1,
            blocks: context.budget.rounds,
          });
        }
      }
    }

    if (verification) {
      for (const item of prepared) {
        if (!verification.ranked.has(item.key)) continue;
        const change = await stateChange(group.id, item, verification.references, mode, context.timeoutMs);
        if (change === undefined) continue;
        context.warnings.push({
          code: 'state-mutated',
          group: group.id,
          case: item.key,
          message: `"${item.key}" in "${group.id}": run() changed its input during timing; give each call fresh state or do not mutate (${change}).`,
        });
      }
    }

    const blocks = new Map<string, readonly Block[]>();
    let floorBlocks: readonly Block[] = [];
    for (const entry of entries) {
      if (entry.key === undefined) floorBlocks = entry.blocks;
      else blocks.set(entry.key, entry.blocks);
    }
    return { blocks, floor: summarize(floorBlocks, { seed: context.seed }), floorBlocks };
  } finally {
    // Every state is torn down, even when timing failed or another teardown threw, so a run never leaks connections.
    const errors: string[] = [];
    for (const { key, spec, states } of prepared) {
      if (!spec.teardown) continue;
      for (const state of states) {
        try {
          await spec.teardown(state);
        } catch (error) {
          errors.push(`case "${key}": ${describeError(error)}`);
        }
      }
    }
    if (errors.length > 0) {
      context.warnings.push({
        code: 'teardown-failed',
        group: group.id,
        message: `teardown() failed ${errors.length === 1 ? 'once' : `${errors.length} times`} in "${group.id}" after timing: ${errors.join('; ')}. What setup() opened may still be open.`,
      });
    }
  }
}

function speedCase(
  group: GroupSpec,
  key: string,
  meta: { label?: string; package?: string; differs?: string },
  role: CaseRole,
  blocks: readonly Block[],
  context: RunContext,
): CaseResult {
  return {
    key,
    label: meta.label ?? key,
    ...(meta.package === undefined ? {} : { package: meta.package }),
    role,
    ...(meta.differs === undefined ? {} : { differs: meta.differs }),
    workHash: workHash(group, key),
    summary: summarize(blocks, { seed: context.seed }),
    blocks,
    // Flags (and their warnings) are derived from the data by assessResult.
    flags: [],
  };
}

function compareRole(group: CompareSpec<unknown>, key: string): CaseRole {
  const spec = group.cases[key]!;
  if (key === group.baseline) return 'baseline';
  if (spec.differs !== undefined) return 'differs';
  if (spec.variant) return 'variant';
  return 'competitor';
}

const groupHash = (suite: SuiteSpec, group: GroupSpec): string => specHash({ id: suite.id, groups: [group] });

async function runCompare(suite: SuiteSpec, group: CompareSpec<unknown>, context: RunContext): Promise<GroupResult> {
  const mode = group.mode ?? 'sync';
  const base = {
    kind: 'compare' as const,
    id: group.id,
    title: group.title,
    ...(group.note === undefined ? {} : { note: group.note }),
    unit: SPEED_UNIT,
    contract: group.contract,
    specHash: groupHash(suite, group),
    baseline: group.baseline,
  };

  context.progress({ type: 'check', group: group.id });
  const copies = inputCopies(group.id, group.inputs, context.warnings);
  const { check, references } = await checkContract(group, mode, context.timeoutMs, copies);
  // Not timed; assessResult adds the blocking `contract-failed` warning.
  if (check.status === 'failed') return { ...base, check, cases: [], comparisons: [] };
  const ranked = new Set<string>();
  for (const [key, spec] of Object.entries(group.cases)) {
    if (spec.differs === undefined) ranked.add(key);
    else await probe(group.id, key, spec, group.inputs.length, copies, mode, context.timeoutMs);
  }

  const { blocks, floor, floorBlocks } = await measureSpeed(group, group.inputs.length, copies, mode, context, {
    references,
    ranked,
  });
  const cases = Object.entries(group.cases).map(([key, spec]) =>
    speedCase(group, key, spec, compareRole(group, key), blocks.get(key)!, context),
  );
  const baseBlocks = blocks.get(group.baseline);
  const comparisons: Comparison[] = [];
  if (baseBlocks) {
    for (const [key, spec] of Object.entries(group.cases)) {
      if (key === group.baseline || spec.differs !== undefined) continue;
      comparisons.push({ case: key, ...compareBlocks(baseBlocks, blocks.get(key)!, { seed: context.seed }) });
    }
  }
  return { ...base, check, floor, floorBlocks, cases, comparisons };
}

async function runScenario(suite: SuiteSpec, group: ScenarioSpec<unknown>, context: RunContext): Promise<GroupResult> {
  const mode = group.mode ?? 'sync';
  const inputs = group.inputs ?? [undefined];
  const copies = inputCopies(group.id, inputs, context.warnings);
  for (const [key, spec] of Object.entries(group.cases))
    await probe(group.id, key, spec, inputs.length, copies, mode, context.timeoutMs);
  const { blocks, floor, floorBlocks } = await measureSpeed(group, inputs.length, copies, mode, context);
  return {
    kind: 'scenario',
    id: group.id,
    title: group.title,
    ...(group.note === undefined ? {} : { note: group.note }),
    unit: SPEED_UNIT,
    specHash: groupHash(suite, group),
    floor,
    floorBlocks,
    // Scenario cases are not ranked; 'competitor' is the neutral role.
    cases: Object.entries(group.cases).map(([key, spec]) =>
      speedCase(group, key, spec, 'competitor', blocks.get(key)!, context),
    ),
    comparisons: [],
  };
}

// ---------------------------------------------------------------------------
// Metric and size groups
// ---------------------------------------------------------------------------

/**
 * Metric comparisons against the baseline (lower is better). The estimator is
 * the median: a deterministic metric compares its medians exactly; a repeated
 * one bootstraps the ratio of medians from its observations (`blocks` with
 * `ops` = 1, see `compareMedians`). Shared with the host, which recomputes
 * them after merging processes.
 */
export function metricComparisons(
  group: Pick<GroupResult, 'baseline' | 'deterministic' | 'cases'>,
  seed: number,
): Comparison[] {
  const base = group.cases.find(entry => entry.key === group.baseline);
  if (!base || base.summary.estimate === 0) return [];
  const comparisons: Comparison[] = [];
  for (const entry of group.cases) {
    if (entry.key === group.baseline || entry.role === 'differs') continue;
    if (group.deterministic === true) {
      comparisons.push({ case: entry.key, ...exactComparison(base.summary.estimate, entry.summary.estimate) });
    } else if (base.blocks?.length && entry.blocks?.length) {
      comparisons.push({ case: entry.key, ...compareMedians(base.blocks, entry.blocks, { seed }) });
    }
  }
  return comparisons;
}

async function runMetric(suite: SuiteSpec, group: MetricSpec, context: RunContext): Promise<GroupResult> {
  const keys = Object.keys(group.cases);
  const observations = new Map<string, Block[]>(keys.map(key => [key, []]));
  const repeats = group.deterministic ? 1 : context.budget.metricRepeats;
  const random = createRandom(mixSeed(context.seed, `${context.process}/${group.id}`));
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const key of shuffle(keys, random)) {
      const value = await group.cases[key]!.collect();
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new TypeError(
          `Group "${group.id}", case "${key}": collect() returned ${formatValue(value)}; it must return a finite number ≥ 0 (a metric is a cost: lower is better).`,
        );
      }
      observations.get(key)!.push({ process: context.process, block: repeat, ns: value, ops: 1 });
    }
  }
  const cases = keys.map((key): CaseResult => {
    const spec = group.cases[key]!;
    const role: CaseRole = key === group.baseline ? 'baseline' : spec.differs === undefined ? 'competitor' : 'differs';
    const blocks = observations.get(key)!;
    return {
      key,
      label: spec.label ?? key,
      ...(spec.package === undefined ? {} : { package: spec.package }),
      role,
      ...(spec.differs === undefined ? {} : { differs: spec.differs }),
      workHash: workHash(group, key),
      summary: summarizeValues(
        blocks.map(block => block.ns),
        { seed: context.seed },
      ),
      blocks,
      flags: [],
    };
  });
  return {
    kind: 'metric',
    id: group.id,
    title: group.title,
    ...(group.note === undefined ? {} : { note: group.note }),
    unit: group.unit,
    specHash: groupHash(suite, group),
    deterministic: group.deterministic,
    baseline: group.baseline,
    cases,
    comparisons: metricComparisons(
      { baseline: group.baseline, deterministic: group.deterministic, cases },
      context.seed,
    ),
  };
}

async function runSize(
  suite: SuiteSpec,
  group: SizeSpec,
  options: RunOptions,
  context: RunContext,
): Promise<GroupResult | undefined> {
  if (!options.sizeRunner) {
    context.warnings.push({
      code: 'size-skipped',
      group: group.id,
      message: `Size group "${group.id}" was skipped: it needs a bundler. Run it through the Node host (arki-bench / @arki/bench/node).`,
    });
    return undefined;
  }
  const result = await options.sizeRunner(group);
  if (result.warnings) context.warnings.push(...result.warnings);
  return {
    ...result,
    specHash: result.specHash ?? groupHash(suite, group),
    cases: result.cases.map(entry => ({ ...entry, workHash: workHash(group, entry.key) })),
  };
}

// ---------------------------------------------------------------------------
// Assessment: flags, warnings and publishability, derived from the data
// ---------------------------------------------------------------------------

export { BLOCKING_WARNINGS } from './warnings.js';

const BLOCKING = new Set(BLOCKING_WARNINGS);

/** Codes `assessResult` derives from the data itself; it drops and regenerates them. */
const DERIVED = new Set([
  'quick-profile',
  'explore-profile',
  'contract-failed',
  'optimized-out',
  'floor-unreliable',
  'unstable',
]);

const PROFILE_WARNINGS: Readonly<Record<Profile, Warning | undefined>> = {
  quick: { code: 'quick-profile', message: 'Quick runs are smoke tests: too few blocks to publish.' },
  explore: {
    code: 'explore-profile',
    message: 'Explore runs are for development: only a publish run (several fresh processes) can be published.',
  },
  publish: undefined,
};

function caseFlagsFor(group: GroupResult, entry: CaseResult, maxCv: number): Flag[] {
  switch (group.kind) {
    case 'size': {
      return entry.limit !== undefined && entry.size !== undefined && entry.size.gzip > entry.limit
        ? ['over-limit']
        : [];
    }
    case 'metric': {
      // A deterministic metric is collected once: there is no spread to judge.
      if (group.deterministic === true) return [];
      return entry.summary.n > 1 && entry.summary.cv > maxCv ? ['unstable'] : [];
    }
    default: {
      return caseFlags(entry.summary, group.floor, maxCv);
    }
  }
}

function flagWarning(group: GroupResult, entry: CaseResult, flag: Flag, maxCv: number): Warning | undefined {
  const { key } = entry;
  const { summary } = entry;
  if (flag === 'optimized-out') {
    const floor = group.floor?.min ?? Number.NaN;
    return {
      code: 'optimized-out',
      group: group.id,
      case: key,
      message: `"${key}" in "${group.id}" (${summary.estimate.toPrecision(3)} ns/op) is within the empty-function floor (fastest block ${summary.min.toPrecision(3)} ns/op vs the floor's ${floor.toPrecision(3)} ns/op): its work was probably optimized away or is too small to measure. Make run() depend on its state and return the result.`,
    };
  }
  if (flag === 'unstable') {
    const over = group.kind === 'metric' ? 'repeats' : 'blocks';
    return {
      code: 'unstable',
      group: group.id,
      case: key,
      message: `"${key}" in "${group.id}" varies ${(summary.cv * 100).toFixed(1)}% across ${over} (limit ${(maxCv * 100).toFixed(0)}%). Close other programs or run again.`,
    };
  }
  // over-limit is a flag, not a warning: it fails `--ci` and `compare`, and does not block publishing.
  return undefined;
}

function assessGroup(group: GroupResult, maxCv: number, warnings: Warning[]): GroupResult {
  const failure = group.check?.status === 'failed' ? group.check.failures[0] : undefined;
  if (group.check?.status === 'failed') {
    warnings.push({
      code: 'contract-failed',
      group: group.id,
      ...(failure === undefined ? {} : { case: failure.case }),
      message: `"${group.id}" was not timed: ${group.check.failures.length} contract failure(s).${failure ? ` First: case "${failure.case}", input ${failure.input}: expected ${failure.expected}, got ${failure.actual}.` : ''}`,
    });
  }
  if (
    (group.kind === 'compare' || group.kind === 'scenario') &&
    group.floor &&
    group.floor.min > FLOOR_TRUST_LIMIT_NS
  ) {
    warnings.push({
      code: 'floor-unreliable',
      group: group.id,
      message: `The empty-function floor in "${group.id}" took ${group.floor.min.toPrecision(3)} ns/op (an empty call costs a few ns): the machine interrupted the measurement, so optimized-away work cannot be detected. Close other programs and run again.`,
    });
  }
  const cases = group.cases.map(entry => {
    const flags = caseFlagsFor(group, entry, maxCv);
    for (const flag of flags) {
      const warning = flagWarning(group, entry, flag, maxCv);
      if (warning) warnings.push(warning);
    }
    return { ...entry, flags };
  });
  return { ...group, cases };
}

/**
 * Derives every case's flags, the data-driven warnings and `publishable` from
 * a result, the same way wherever it runs: the engine calls it at the end of
 * `runSuite`, and the host calls it again after merging processes, so the
 * two can never disagree. Flags: `optimized-out` against the group's floor,
 * `unstable` when a timed case (or a repeated metric) varies more than
 * `maxCv` (default: the profile's), `over-limit` for a size above its
 * budget. Warnings derived here (profile, contract, floor, flags) are dropped
 * and regenerated; all others are kept. `publishable` is true only when no
 * warning is in `BLOCKING_WARNINGS`, so only a `publish` run can be.
 */
export function assessResult(result: BenchResult, options: { maxCv?: number } = {}): BenchResult {
  const maxCv = options.maxCv ?? PROFILE_BUDGETS[result.profile].maxCv;
  const groupWarnings: Warning[] = [];
  const groups = result.groups.map(group => assessGroup(group, maxCv, groupWarnings));
  const profileWarning = PROFILE_WARNINGS[result.profile];
  const warnings = [
    ...(profileWarning ? [profileWarning] : []),
    ...result.warnings.filter(warning => !DERIVED.has(warning.code)),
    ...groupWarnings,
  ];
  return { ...result, groups, warnings, publishable: !warnings.some(warning => BLOCKING.has(warning.code)) };
}

// ---------------------------------------------------------------------------
// runSuite
// ---------------------------------------------------------------------------

/**
 * Validates and runs a suite in this process and returns the result. Throws a
 * SpecError for an invalid suite, a filter that selects nothing, or misuse
 * (a promise from a sync-mode case or from setup). Contract failures do not
 * throw: the group is reported with `check.status = 'failed'` and is not timed.
 */
export async function runSuite(suite: SuiteSpec, options: RunOptions = {}): Promise<BenchResult> {
  validateSuite(suite);
  const profile = options.profile ?? 'explore';
  const budget: Budget = { ...PROFILE_BUDGETS[profile], ...options.budget };
  checkBudget(budget);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(timeoutMs > 0)) throw new RangeError('timeoutMs must be > 0.');

  const groups: GroupSpec[] = [];
  for (const group of suite.groups) {
    const selected = selectGroup(group, options.filter);
    if (selected) groups.push(selected);
  }
  if (groups.length === 0) {
    throw new SpecError([`Filter ${String(options.filter)} matches no group id or group/case of suite "${suite.id}".`]);
  }

  prepareSink();
  const date = new Date().toISOString();
  const seed = options.seed ?? DEFAULT_SEED;
  const warnings: Warning[] = [];
  const context: RunContext = {
    seed,
    process: options.process ?? 0,
    budget,
    timeoutMs,
    gc: realGc(),
    progress: event => options.onProgress?.(event),
    warnings,
  };

  if (options.filter !== undefined) {
    // A README section rebuilt from a filtered run would silently drop the other groups.
    warnings.push({
      code: 'filtered',
      message: `Filtered run (${String(options.filter)}): only part of the suite was measured.`,
    });
  }

  const results: GroupResult[] = [];
  for (const group of groups) {
    let result: GroupResult | undefined;
    switch (group.kind) {
      case 'scenario': {
        result = await runScenario(suite, group, context);
        break;
      }
      case 'metric': {
        result = await runMetric(suite, group, context);
        break;
      }
      case 'size': {
        result = await runSize(suite, group, options, context);
        break;
      }
      default: {
        result = await runCompare(suite, group, context);
      }
    }
    if (result) results.push(result);
    context.progress({ type: 'done', group: group.id });
  }

  return assessResult(
    {
      schema: 1,
      suite: {
        id: suite.id,
        title: suite.title ?? 'Benchmarks',
        ...(suite.intro === undefined ? {} : { intro: suite.intro }),
        notes: suite.notes ?? [],
        specHash: specHash(suite),
      },
      profile,
      seed,
      publishable: false,
      warnings,
      environment: {
        runtime: detectRuntime(),
        flags: [],
        harness: { version: VERSION, mitata: MITATA_VERSION },
        date,
      },
      packages: { '@arki/bench': VERSION, mitata: MITATA_VERSION },
      groups: results,
    },
    { maxCv: budget.maxCv },
  );
}
