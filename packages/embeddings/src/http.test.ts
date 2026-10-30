import { describe, expect, it } from 'vitest';

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
