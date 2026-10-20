import { describe, expect, it, vi } from 'vitest';

import { lazyObject, once } from './lazy.js';

describe('once', () => {
  it('runs the computation exactly once and returns the same result', () => {
    const compute = vi.fn(() => ({ value: 42 }));
    const memo = once(compute);

    const first = memo();
    const second = memo();

    expect(first).toBe(second);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('memoizes undefined — the guard is a flag, not the value', () => {
    // The emailClient case: "no client configured" is a legitimate result
    // and must not re-run the (env-observing) computation on every call.
    const compute = vi.fn((): string | undefined => {
      return; // "nothing configured" — a legitimate memoizable result
    });
    const memo = once(compute);

    expect(memo()).toBeUndefined();
    expect(memo()).toBeUndefined();
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not memoize a synchronous throw — the next call retries', () => {
    let attempts = 0;
    const memo = once(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient');
      return 'ok';
    });

    expect(() => memo()).toThrow('transient');
    expect(memo()).toBe('ok');
  });

  it('memoizes a promise, so concurrent callers share one in-flight boot', async () => {
    const compute = vi.fn(() => Promise.resolve('booted'));
    const memo = once(compute);

    const [a, b] = await Promise.all([memo(), memo()]);

    expect(a).toBe('booted');
    expect(b).toBe('booted');
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe('lazyObject', () => {
  it('defers construction to the first property access', () => {
    const build = vi.fn(() => ({ ready: true }));
    const value = lazyObject(build);

    expect(build).not.toHaveBeenCalled();
    expect(value.ready).toBe(true);
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('answers instanceof truthfully (getPrototypeOf delegates to the instance)', () => {
    class Client {}
    const client = lazyObject(() => new Client());

    expect(client instanceof Client).toBe(true);
    expect(Object.getPrototypeOf(client)).toBe(Client.prototype);
  });

  it('writes land on the real instance, not the dummy proxy target', () => {
    const value = lazyObject<{ count: number }>(() => ({ count: 0 }));

    value.count = 7;

    // Without a `set` trap the write goes to the proxy's `{}` target and
    // the next read (which delegates to the instance) silently loses it.
    expect(value.count).toBe(7);
  });

  it('deletes land on the real instance', () => {
    const value = lazyObject<{ flag?: boolean }>(() => ({ flag: true }));

    delete value.flag;

    expect('flag' in value).toBe(false);
  });

  it('binds methods to the real instance so private fields work', () => {
    class Counter {
      #count = 5;
      current() {
        return this.#count;
      }
    }
    const counter = lazyObject(() => new Counter());

    // Unbound, `current` would run with the proxy as `this` and the
    // private-field access would throw — the drizzle/better-auth case.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- deliberately unbound: the proxy's `get` trap pre-binds methods, which is what this test proves
    const { current } = counter;
    expect(current()).toBe(5);
    expect(counter.current()).toBe(5);
  });

  it('supports spreads and key enumeration', () => {
    const value = lazyObject(() => ({ a: 1, b: 2 }));

    expect({ ...value }).toEqual({ a: 1, b: 2 });
    expect(Object.keys(value).toSorted()).toEqual(['a', 'b']);
  });

  it('enumerates frozen instances without violating the virtual target descriptors', () => {
    const instance = Object.freeze({ endpoint: 'local' });
    const build = vi.fn(() => instance);
    const value = lazyObject(build);

    expect(Object.keys(value)).toEqual(['endpoint']);
    expect({ ...value }).toEqual(instance);
    expect(Object.getOwnPropertyDescriptor(value, 'endpoint')).toEqual({
      value: 'local',
      writable: false,
      enumerable: true,
      configurable: true,
    });
    expect(Object.getOwnPropertyDescriptor(value, 'missing')).toBeUndefined();
    expect(Reflect.set(value, 'endpoint', 'remote')).toBe(false);
    expect(Reflect.deleteProperty(value, 'endpoint')).toBe(false);
    expect(value.endpoint).toBe('local');
    expect(build).toHaveBeenCalledTimes(1);
  });

  it('enumerates nonconfigurable accessors without reading them during reflection', () => {
    const read = vi.fn(() => 'ready');
    const instance = Object.defineProperty({}, 'state', {
      get: read,
      enumerable: true,
    });
    const value = lazyObject(() => instance);

    expect(Object.keys(value)).toEqual(['state']);
    expect(read).not.toHaveBeenCalled();
    expect({ ...value }).toEqual({ state: 'ready' });
    expect(read).toHaveBeenCalledTimes(1);
  });
});
