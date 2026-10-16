/**
 * A barrier for tests on a fake clock: WebCrypto (cursor seals, receipts)
 * finishes on a thread pool at no fixed point of the event loop, so a test
 * waits for every call in flight before it reads what a stream has.
 */
import { vi } from 'vitest';

/** One turn of the event loop: a message on a fresh channel (portable, and not faked by `vi.useFakeTimers`). */
function macrotask(): Promise<void> {
  return new Promise<void>(resolve => {
    const channel = new MessageChannel();
    channel.port1.addEventListener('message', () => {
      channel.port1.close();
      resolve();
    });
    channel.port1.start();
    channel.port2.postMessage(0);
  });
}

/**
 * WebCrypto finishes on a thread pool at no fixed point of the event loop: wait for every call in
 * flight, let the stream pumps run, and repeat until a turn starts none.
 */
export function cryptoBarrier(): { settle(): Promise<void>; restore(): void } {
  const inFlight = new Set<Promise<unknown>>();
  const subtle = globalThis.crypto.subtle;
  function track<T>(promise: Promise<T>): Promise<T> {
    inFlight.add(promise);
    const forget = (): void => {
      inFlight.delete(promise);
    };
    promise.then(forget, forget);
    return promise;
  }
  const encrypt = subtle.encrypt.bind(subtle);
  const decrypt = subtle.decrypt.bind(subtle);
  const sign = subtle.sign.bind(subtle);
  const spies = [
    vi.spyOn(subtle, 'encrypt').mockImplementation((...args) => track(encrypt(...args))),
    vi.spyOn(subtle, 'decrypt').mockImplementation((...args) => track(decrypt(...args))),
    vi.spyOn(subtle, 'sign').mockImplementation((...args) => track(sign(...args))),
  ];
  return {
    async settle() {
      for (let quiet = 0; quiet < 3;) {
        await macrotask();
        if (inFlight.size === 0) quiet += 1;
        else {
          quiet = 0;
          await Promise.allSettled(inFlight);
        }
      }
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}
