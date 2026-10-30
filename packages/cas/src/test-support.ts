/// <reference types="node" />
/**
 * Test scaffolding, Node only (vitest runs on Node). Excluded from the build.
 *
 * Time bounds for tests (RFC §13: hostile inputs end within 100 ms, 1 s for
 * `factor`) are measured in CPU time, which does not grow while other
 * programs hold the CPU, so a loaded machine cannot fail them. A cold JIT can
 * still slow one run; the work is deterministic, so the fastest of a few runs
 * measures it.
 */
import { cpuUsage } from 'node:process';

import { isFailure, UnexpectedFailure } from '@arki/failure';

import type { CasResult } from './core.js';
import type { Derivation } from './derivation.js';
import type { CasTextFailure } from './failures.js';
import type { Factored, PolynomialIn, Rationalized } from './polynomial.js';
import type { SimplifyResult } from './simplify.js';
import { derivation as realDerivation } from './derivation.js';
import { derivative as realDerivative } from './derivative.js';
import {
  collect as realCollect,
  expand as realExpand,
  factor as realFactor,
  gcd as realGcd,
  polynomialIn as realPolynomialIn,
  rationalize as realRationalize,
} from './polynomial.js';
import { simplify as realSimplify } from './simplify.js';

/** One run: its CPU time in ms, and the value it returned or the error it threw. */
export type Timed<T> =
  | { readonly ms: number; readonly ok: true; readonly value: T }
  | { readonly ms: number; readonly ok: false; readonly error: unknown };

function once<T>(run: () => T): Timed<T> {
  const start = cpuUsage();
  const elapsed = (): number => {
    const { user, system } = cpuUsage(start);
    return (user + system) / 1000;
  };
  try {
    const value = run();
    return { ms: elapsed(), ok: true, value };
  } catch (error) {
    return { ms: elapsed(), ok: false, error };
  }
}

/** The fastest of up to `attempts` runs of `run`, stopping at the first run under `bound` ms. */
export function fastest<T>(run: () => T, bound: number, attempts = 3): Timed<T> {
  let best = once(run);
  for (let attempt = 1; attempt < attempts && best.ms >= bound; attempt++) {
    const next = once(run);
    if (next.ms < best.ms) best = next;
  }
  return best;
}

/**
 * The verbs as they behaved before strings returned failures: a failure is thrown as its `cause` (the `ParseError`,
 * `CasError`, `CasLimitError`...). Most tests feed strings and assert on the value or on the thrown error; the
 * returned failures themselves are tested in `text.test.ts` against the real verbs.
 */
function raise(failure: CasTextFailure): never {
  if (failure.cause instanceof Error) throw failure.cause;
  throw new UnexpectedFailure(failure);
}

export function derivative(...args: Parameters<typeof realDerivative>): CasResult {
  const out = realDerivative(...args);
  return isFailure(out) ? raise(out) : out;
}
export function derivation(...args: Parameters<typeof realDerivation>): Derivation {
  const out = realDerivation(...args);
  return isFailure(out) ? raise(out) : out;
}
export function simplify(...args: Parameters<typeof realSimplify>): SimplifyResult {
  const out = realSimplify(...args);
  return isFailure(out) ? raise(out) : out;
}
export function expand(...args: Parameters<typeof realExpand>): CasResult {
  const out = realExpand(...args);
  return isFailure(out) ? raise(out) : out;
}
export function collect(...args: Parameters<typeof realCollect>): CasResult {
  const out = realCollect(...args);
  return isFailure(out) ? raise(out) : out;
}
export function rationalize(...args: Parameters<typeof realRationalize>): Rationalized {
  const out = realRationalize(...args);
  return isFailure(out) ? raise(out) : out;
}
export function gcd(...args: Parameters<typeof realGcd>): CasResult {
  const out = realGcd(...args);
  return isFailure(out) ? raise(out) : out;
}
export function polynomialIn(...args: Parameters<typeof realPolynomialIn>): PolynomialIn {
  const out = realPolynomialIn(...args);
  return isFailure(out) ? raise(out) : out;
}
export function factor(...args: Parameters<typeof realFactor>): Factored {
  const out = realFactor(...args);
  return isFailure(out) ? raise(out) : out;
}
