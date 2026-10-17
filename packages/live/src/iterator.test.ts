import { describe, expect, it, vi } from 'vitest';

import { pullIterator } from './iterator.js';

/** Counts 0, 1, 2, … for ever; `cleanup` is a spy. */
function counter() {
  let count = 0;
  const cleanup = vi.fn();
  const iterator = pullIterator<number>(() => Promise.resolve({ done: false, value: count++ }), cleanup);
  return { iterator, cleanup };
}

// Why: Hermes has no async generators, so the streams use this instead. It must keep a generator's
// promises, or a stream that ends early leaks its reader, its hub slot or its listener.
describe('pullIterator', () => {
  it('an early return() runs cleanup once, and the iterator is done after it', async () => {
    const { iterator, cleanup } = counter();
    expect(await iterator.next()).toEqual({ done: false, value: 0 });
    expect(await iterator.return?.()).toEqual({ done: true, value: undefined });
    await iterator.return?.();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('break in for await runs cleanup', async () => {
    const { iterator, cleanup } = counter();
    for await (const value of iterator) if (value === 2) break;
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a return() before the first next() runs cleanup too, so a stream never read is not leaked', async () => {
    const { iterator, cleanup } = counter();
    await iterator.return?.();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a pull that fails runs cleanup, then rejects with its error', async () => {
    const cleanup = vi.fn();
    const iterator = pullIterator<number>(() => Promise.reject(new Error('lost')), cleanup);
    await expect(iterator.next()).rejects.toThrow('lost');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('a pull that says done runs cleanup once', async () => {
    const cleanup = vi.fn();
    const iterator = pullIterator<number>(() => Promise.resolve({ done: true, value: undefined }), cleanup);
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    await iterator.return?.();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('calls run one at a time: a return() waits for the pending next()', async () => {
    const order: string[] = [];
    const answers: ((result: IteratorResult<number, void>) => void)[] = [];
    const iterator = pullIterator<number>(
      () =>
        new Promise(resolve => {
          answers.push(resolve);
        }),
      () => {
        order.push('cleanup');
      },
    );
    const pending = iterator.next().then(result => order.push(`next ${String(result.value)}`));
    const returned = iterator.return?.().then(() => order.push('return'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual([]);
    for (const answer of answers) answer({ done: false, value: 1 });
    await Promise.all([pending, returned]);
    expect(order).toEqual(['next 1', 'cleanup', 'return']);
  });
});
