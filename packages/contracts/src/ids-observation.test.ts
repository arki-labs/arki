import { afterEach, describe, expect, it, vi } from 'vitest';

import { UnexpectedDefect } from '@arki/failure';

import { defineId } from './ids.js';

const routes = [
  { name: 'cuid', nativeUuid: false, generate: () => defineId('cuid_').create() },
  {
    name: 'custom',
    nativeUuid: false,
    generate: () => defineId('custom_', { kind: 'custom', format: { alphabet: 'abc', length: 21 } }).create(),
  },
  {
    name: 'native UUID',
    nativeUuid: true,
    generate: () => defineId('uuid_', { kind: 'uuid', format: 'uuid' }).create(),
  },
  {
    name: 'fallback UUID',
    nativeUuid: false,
    generate: () => defineId('fallback_', { kind: 'fallback', format: 'uuid' }).create(),
  },
];

afterEach(() => vi.unstubAllGlobals());

it('reserves native promise observation before a provider constructor can reenter generation', async () => {
  const factory = defineId('uuid_', { kind: 'uuid', format: 'uuid' });
  let reentered = false;
  const readConstructor = vi.fn(() => {
    if (!reentered) {
      reentered = true;
      expect(UnexpectedDefect.is(factory.create())).toBe(true);
    }
    return Promise;
  });
  const asynchronous = Object.defineProperty(Promise.reject(new Error('private provider rejection')), 'constructor', {
    get: readConstructor,
  });
  let providerCalls = 0;
  const provider = () => {
    providerCalls++;
    return asynchronous;
  };
  vi.stubGlobal('crypto', { randomUUID: provider });

  expect(UnexpectedDefect.is(factory.create())).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(readConstructor).toHaveBeenCalledTimes(1);
  expect(providerCalls).toBe(2);
});

describe.each([false, true])('asynchronous provider violations (thrown: %s)', thrown => {
  it.each(routes)('observes $name native rejection without reading its hostile then property', async route => {
    const privateCause = new Error('private entropy rejection');
    const readThen = vi.fn(() => {
      throw new Error('Provider-owned then must not be used for native observation');
    });
    // eslint-disable-next-line unicorn/no-thenable -- Malformed native provider work must not escape rejection observation.
    const asynchronous = Object.defineProperty(Promise.reject(privateCause), 'then', { get: readThen });
    const provider = () => {
      if (thrown) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Deliberately malformed foreign provider throws asynchronous work.
        throw asynchronous;
      }
      return asynchronous;
    };
    vi.stubGlobal('crypto', route.nativeUuid ? { randomUUID: provider } : { getRandomValues: provider });
    const result = route.generate();
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateCause.message);
    // Vitest treats any rejected work left unobserved after this turn as an error.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readThen).not.toHaveBeenCalled();
  });
});
