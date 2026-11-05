import { afterEach, describe, expect, it } from 'vitest';

import { requestSignal } from './http.js';

describe('requestSignal', () => {
  it('aborts once the timeout passes, without aborting the caller signal', async () => {
    const caller = new AbortController();
    const signal = requestSignal(caller.signal, 20);

    await new Promise(resolve => setTimeout(resolve, 60));

    expect(signal.aborted).toBe(true);
    // The model tells a timeout (unreachable, retryable) from a cancel by reading the caller signal.
    expect(caller.signal.aborted).toBe(false);
  });

  it('aborts as soon as the caller aborts', () => {
    const caller = new AbortController();
    const signal = requestSignal(caller.signal, 60_000);

    caller.abort();

    expect(signal.aborted).toBe(true);
  });

  it('has a timeout even with no caller signal', () => {
    expect(requestSignal(undefined, 60_000).aborted).toBe(false);
  });
});

// React Native's AbortSignal is the `abort-controller` package, which has no `timeout` and no `any`.
describe('requestSignal without AbortSignal.timeout and AbortSignal.any', () => {
  const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  const any = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
  const removeStatics = (): void => {
    Reflect.deleteProperty(AbortSignal, 'timeout');
    Reflect.deleteProperty(AbortSignal, 'any');
  };
  afterEach(() => {
    if (timeout) Object.defineProperty(AbortSignal, 'timeout', timeout);
    if (any) Object.defineProperty(AbortSignal, 'any', any);
  });

  it('still times out, so a hung provider cannot stall a React Native app', async () => {
    removeStatics();
    const caller = new AbortController();
    const signal = requestSignal(caller.signal, 20);

    await new Promise(resolve => setTimeout(resolve, 60));

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
    expect(caller.signal.aborted).toBe(false);
  });

  it('still follows the caller abort with its reason, so a cancel stays a cancel', () => {
    removeStatics();
    const caller = new AbortController();
    const signal = requestSignal(caller.signal, 60_000);

    caller.abort('stop');

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('stop');
  });

  it('starts aborted when the caller already aborted', () => {
    removeStatics();
    const caller = new AbortController();
    caller.abort('early');

    const signal = requestSignal(caller.signal, 60_000);

    expect(signal.aborted).toBe(true);
    expect(signal.reason).toBe('early');
  });
});
