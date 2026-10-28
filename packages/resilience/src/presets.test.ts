import { describe, expect, it, vi } from 'vitest';

import { UnexpectedDefect } from '@arki/failure';

import { backoff, CircuitOpen, definePresets } from './index.js';

const boom = (): never => {
  throw new Error('down');
};

describe('definePresets', () => {
  it('gives each name its own breaker, so one dead downstream does not block another', async () => {
    const presets = definePresets({
      carrier: { circuitBreaker: { consecutiveFailures: 1 }, retry: backoff.constant(1).upTo(0) },
      db: { circuitBreaker: { consecutiveFailures: 1 }, retry: backoff.constant(1).upTo(0) },
    });
    expect(UnexpectedDefect.is(await presets.carrier.execute(boom))).toBe(true);

    await expect(presets.carrier.execute(() => 1)).resolves.toMatchObject({ code: CircuitOpen.code });
    expect(await presets.db.execute(() => 'fine')).toBe('fine');
  });

  it('applies the options of its own name, not defaults', async () => {
    const presets = definePresets({ flaky: { retry: backoff.constant(1).upTo(2) } });
    const fn = vi.fn(boom);
    expect(UnexpectedDefect.is(await presets.flaky.execute(fn))).toBe(true);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('components are the parts the preset runs, so their events fire on a composed call', async () => {
    const presets = definePresets({
      x: { circuitBreaker: { consecutiveFailures: 2 }, retry: backoff.constant(1).upTo(1) },
    });
    const onRetry = vi.fn();
    const onBreak = vi.fn();
    presets.x.components.retry.onRetry(onRetry);
    presets.x.components.circuitBreaker.onBreak(onBreak);
    expect(UnexpectedDefect.is(await presets.x.execute(boom))).toBe(true);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onBreak).toHaveBeenCalledTimes(1);
  });

  it('has a bulkhead component only when one was configured', () => {
    const presets = definePresets({ plain: {}, limited: { bulkhead: { maxConcurrent: 1 } } });
    expect(presets.plain.components.bulkhead).toBeUndefined();
    expect('bulkhead' in presets.plain.components).toBe(false);
    expect(presets.limited.components.bulkhead).toBeDefined();
  });

  it('keeps names like toString as ordinary preset names', () => {
    const presets = definePresets({ toString: {}, constructor: {} });
    expect(Object.keys(presets)).toEqual(['toString', 'constructor']);
    expect(typeof presets.toString.execute).toBe('function');
  });
});
