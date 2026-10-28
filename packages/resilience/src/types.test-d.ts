import type { ExecutionFailure } from './errors.js';
import { describe, expectTypeOf, it } from 'vitest';

import type { ResilienceService } from './dot.js';
import type { Policy, Presets } from './index.js';
import { createRetryPolicy, definePresets, noop, withFallback, withResilience, wrap } from './index.js';

describe('policy types', () => {
  it('a fallback adds its type to the result: T | F', () => {
    expectTypeOf(withFallback(noop, () => null).execute(() => 1)).toEqualTypeOf<Promise<number | null | ExecutionFailure>>();
  });

  it('an async fallback unwraps', () => {
    expectTypeOf(withFallback(noop, () => Promise.resolve('x'))).toEqualTypeOf<Policy<string>>();
  });

  it('a fallback that rethrows adds nothing for the throwing branch', () => {
    const policy = withFallback(noop, (error: unknown) => {
      if (error instanceof RangeError) throw error;
      return { stale: true as const };
    });
    expectTypeOf(policy).toEqualTypeOf<Policy<{ stale: true }>>();
  });

  it('fallbacks nest', () => {
    const nested = withFallback(
      withFallback(noop, () => null),
      () => 0 as const,
    );
    expectTypeOf(nested).toEqualTypeOf<Policy<0 | null>>();
  });

  it('a policy with a fallback is not a plain Policy', () => {
    // @ts-expect-error -- it can resolve a value the function never returned
    const plain: Policy = withFallback(noop, () => null);
    void plain;
    const withNull = withFallback(noop, () => null);
    // @ts-expect-error -- a fallback inside wrap would swallow the errors the retry needs
    const wrapped = wrap(withNull, createRetryPolicy());
    void wrapped;
  });

  it('withResilience keeps T for a plain policy and adds F for a fallback', () => {
    expectTypeOf(withResilience(() => 42, noop)).toEqualTypeOf<Promise<number | ExecutionFailure>>();
    expectTypeOf(
      withResilience(
        () => 42,
        withFallback(noop, () => 'x'),
      ),
    ).toEqualTypeOf<Promise<number | string | ExecutionFailure>>();
  });
});

describe('presets types', () => {
  it('names are inferred, so an unknown name does not compile', () => {
    const presets = definePresets({ carrier: {} });
    expectTypeOf(presets).toEqualTypeOf<Presets<'carrier'>>();
    const service = {} as ResilienceService<'carrier'>;
    // @ts-expect-error -- not a preset name
    service.for('nope');
    // @ts-expect-error -- not a preset name
    void service.run('nope', () => 1);
  });

  it('a misspelled option does not compile', () => {
    // @ts-expect-error -- circuitbreaker
    definePresets({ a: { circuitbreaker: {} } });
    // @ts-expect-error -- timeoutMs, not timeout
    definePresets({ a: { timeout: { timeout: 1 } } });
  });
});
