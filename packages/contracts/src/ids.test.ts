import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';

import { isFailure, orThrow, revive, serialize, UnexpectedDefect } from '@arki/failure';

import type { IdGenerationFailure, IdOf } from './ids.js';
import { RandomSourceUnavailable } from './errors.js';
import { assertUniqueIdPrefixes, defineId, ID_GENERATION_FAILURES, userIdSchema } from './ids.js';

describe('userIdSchema', () => {
  it('accepts a string that starts with usr_ and keeps it as is', () => {
    expect(userIdSchema.parse('usr_abc123')).toBe('usr_abc123');
  });

  it('rejects other prefixes and non-strings, so a session or account id cannot stand in for a user', () => {
    expect(userIdSchema.safeParse('sess_abc123').success).toBe(false);
    expect(userIdSchema.safeParse('abc123').success).toBe(false);
    expect(userIdSchema.safeParse(42).success).toBe(false);
    expect(userIdSchema.safeParse(null).success).toBe(false);
  });
});

describe('defineId', () => {
  const storyId = defineId('sty_');
  type StoryId = IdOf<typeof storyId>;

  it('infers the id type from the prefix, so the prefix is written once', () => {
    expectTypeOf<StoryId>().toEqualTypeOf<`sty_${string}`>();
    expectTypeOf(storyId.create()).toEqualTypeOf<StoryId | IdGenerationFailure>();
    expectTypeOf(storyId.schema.parse('sty_1')).toEqualTypeOf<StoryId>();
  });

  it('the schema accepts its own ids and rejects another kind, so a pod id cannot stand in for a story', () => {
    expect(storyId.schema.parse('sty_abc')).toBe('sty_abc');
    expect(storyId.schema.safeParse('pod_abc').success).toBe(false);
    expect(storyId.schema.safeParse(42).success).toBe(false);
    expect(storyId.is('sty_abc')).toBe(true);
    expect(storyId.is('pod_abc')).toBe(false);
  });

  it('creates cuid2-shaped ids that its own schema accepts, and never twice the same', () => {
    const ids = Array.from({ length: 500 }, () => orThrow(storyId.create()));
    for (const id of ids) {
      expect(id).toMatch(/^sty_[a-z][a-z0-9]{23}$/);
      expect(storyId.schema.safeParse(id).success).toBe(true);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps stored prefixes exactly, with or without an underscore', () => {
    expect(defineId('pt').create()).toMatch(/^pt[a-z]/);
    expect(defineId('poet_notif_').prefix).toBe('poet_notif_');
  });

  it.each(['', 'legacy:/', 'st y_', 'a.*[b]'])('preserves stored format %j with literal schema matching', prefix => {
    const declaration = defineId(prefix);
    const id = declaration.create();
    expect(declaration.schema.parse(id)).toBe(id);
    expect(declaration.schema.parse(prefix)).toBe(prefix);
    expect(declaration.prefix).toBe(prefix);
    if (prefix) expect(declaration.schema.safeParse(`wrong${prefix}`).success).toBe(false);
  });

  it('is browser-safe: the schema exports a JSON Schema pattern a client can check', () => {
    expect(z.toJSONSchema(storyId.schema)).toMatchObject({ type: 'string', pattern: '^sty_[\\s\\S]{0,}$' });
  });

  it('brands preserve stored bytes and restore their type through canonical JSON boundaries', () => {
    const refundId = defineId('id_', { kind: 'billing.refund' });
    const paymentId = defineId('id_', { kind: 'billing.payment' });
    const stored = 'id_legacy';
    expect(refundId.schema.parse(stored)).toBe(stored);
    expect(paymentId.schema.parse(stored)).toBe(stored);
    const generated = orThrow(refundId.create());
    const encoded = JSON.stringify(generated);
    const wire: unknown = JSON.parse(encoded);
    const decoded = refundId.schema.parse(wire);
    expect(decoded).toBe(generated);
    expectTypeOf(decoded).toEqualTypeOf<IdOf<typeof refundId>>();
    expect(refundId.is(stored)).toBe(true);
    expect(refundId.is('other_legacy')).toBe(false);
    expect(z.toJSONSchema(refundId.schema)).toEqual(z.toJSONSchema(paymentId.schema));
  });

  it.each([null, {}, { kind: 42 }, { kind: '' }])('rejects malformed static domain options %j', options => {
    expect(() => Reflect.apply(defineId, null, ['id_', options])).toThrow('ARKI_CONTRACTS_E009');
  });
});

describe('assertUniqueIdPrefixes', () => {
  it('passes when every prefix is its own', () => {
    expect(() => assertUniqueIdPrefixes(defineId('sty_'), defineId('pod_'), defineId('scn_'))).not.toThrow();
  });

  it('catches the same prefix twice — at compile time too', () => {
    // @ts-expect-error two declarations share "sty_"
    expect(() => assertUniqueIdPrefixes(defineId('sty_'), defineId('sty_'))).toThrow(/"sty_" is declared twice/);
  });

  it('catches a prefix that starts another, because sub_abc would pass both schemas', () => {
    expect(() => assertUniqueIdPrefixes(defineId('sub'), defineId('sub_'))).toThrow(/"sub" is the start of "sub_"/);
  });
});

describe('ContractsError', () => {
  it('carries a stable code and a remediation, and stays a TypeError for older instanceof checks', () => {
    let caught: unknown;
    try {
      // JavaScript callers can supply malformed static definitions.
      Reflect.apply(defineId, null, [42]);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toMatchObject({ name: 'ContractsError', code: 'ARKI_CONTRACTS_E001' });
    expect(caught).toHaveProperty('remediation', expect.stringContaining('string'));
  });
});

describe('ID generation failures', () => {
  const storyId = defineId('sty_');
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('nominal branding preserves the exact returned entropy failure', () => {
    vi.stubGlobal('crypto', null);
    const id = defineId('id_', { kind: 'billing.refund' });
    const result = id.create();
    expect(RandomSourceUnavailable.is(result)).toBe(true);
    expectTypeOf(result).toEqualTypeOf<IdOf<typeof id> | IdGenerationFailure>();
  });

  it.each([undefined, null, false, 'crypto', {}, { getRandomValues: null }, { getRandomValues: 1 }])(
    'returns canonical unavailability for unusable provider %s without weak randomness',
    crypto => {
      vi.stubGlobal('crypto', crypto);
      const weakRandom = vi.spyOn(Math, 'random');
      const result = storyId.create();
      expect(RandomSourceUnavailable.is(result)).toBe(true);
      expect(result).toMatchObject({ code: 'contracts.random_source_unavailable', status: 500, data: undefined });
      expect(weakRandom).not.toHaveBeenCalled();
    },
  );

  it('keeps the crypto receiver, reads the method once, and rejects biased byte ranges', () => {
    const getRandomValues = vi.fn(function (this: unknown, bytes: Uint8Array) {
      expect(this).toBe(provider);
      bytes.fill(0);
      bytes.set([255, 234, 233, 252, 251, 25, 26]);
      return bytes;
    });
    const readMethod = vi.fn(() => getRandomValues);
    const provider = Object.defineProperty({}, 'getRandomValues', { get: readMethod });
    vi.stubGlobal('crypto', provider);
    expect(orThrow(storyId.create())).toBe(`sty_z9z0${'a'.repeat(20)}`);
    expect(readMethod).toHaveBeenCalledTimes(1);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('can refill rejected batches without returning a partial ID', () => {
    let calls = 0;
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(calls++ === 0 ? 255 : 0);
        return bytes;
      },
    });
    expect(storyId.create()).toBe(`sty_${'a'.repeat(24)}`);
    expect(calls).toBe(2);
  });

  it.each(['global getter', 'method getter', 'provider'])('keeps thrown %s defects private', location => {
    const cause = new Error('private entropy service details');
    const fail = () => {
      throw cause;
    };
    if (location === 'global getter') {
      vi.spyOn(globalThis, 'crypto', 'get').mockImplementation(fail);
    } else {
      vi.stubGlobal(
        'crypto',
        location === 'method getter'
          ? Object.defineProperty({}, 'getRandomValues', { get: fail })
          : { getRandomValues: fail },
      );
    }
    const result = storyId.create();
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!isFailure(result)) throw new Error('Expected a generation defect');
    expect(result.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain('private entropy');
    expect({ ...result }).not.toHaveProperty('cause');
  });

  it.each([
    undefined,
    null,
    [],
    new Uint8Array(48),
    {
      [Symbol.iterator]: () => {
        throw new Error('Do not iterate provider output');
      },
    },
  ])('rejects foreign provider output %s without iterating it', output => {
    vi.stubGlobal('crypto', { getRandomValues: () => output });
    expect(UnexpectedDefect.is(storyId.create())).toBe(true);
  });

  it('observes rejected asynchronous provider output while returning a synchronous defect', async () => {
    vi.stubGlobal('crypto', { getRandomValues: () => Promise.reject(new Error('private rejected work')) });
    const result = storyId.create();
    expect(UnexpectedDefect.is(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private rejected work');
    // Vitest fails on unhandled rejections; give the rejection a full turn to surface.
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it('observes hostile thenable output without invoking the provider again', async () => {
    const readThen = vi.fn(() => {
      throw new Error('private then getter');
    });
    // eslint-disable-next-line unicorn/no-thenable -- Intentional malformed foreign protocol fixture.
    const provider = vi.fn(() => Object.defineProperty({}, 'then', { get: readThen }));
    vi.stubGlobal('crypto', { getRandomValues: provider });
    expect(UnexpectedDefect.is(storyId.create())).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(provider).toHaveBeenCalledTimes(1);
    expect(readThen).toHaveBeenCalledTimes(1);
  });

  it('bounds rejection sampling when a provider never supplies an acceptable byte', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(255));
    vi.stubGlobal('crypto', { getRandomValues });
    expect(UnexpectedDefect.is(storyId.create())).toBe(true);
    expect(getRandomValues.mock.calls.length).toBeLessThanOrEqual(100);
  });

  it('reads only its fixed buffer indices even if the provider installs a hostile iterator', () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0);
        Object.defineProperty(bytes, Symbol.iterator, {
          value: () => {
            throw new Error('Do not iterate');
          },
        });
        Object.defineProperty(bytes, 'length', { value: Infinity });
        return bytes;
      },
    });
    expect(storyId.create()).toBe(`sty_${'a'.repeat(24)}`);
  });

  it('refuses detached buffers rather than publishing a partial ID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        const buffer = bytes.buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected a transferable array buffer');
        structuredClone(buffer, { transfer: [buffer] });
        return bytes;
      },
    });
    expect(UnexpectedDefect.is(storyId.create())).toBe(true);
  });

  it('roundtrips only registered canonical generation failures and omits private causes', () => {
    for (const failure of [
      RandomSourceUnavailable({ cause: 'private provider' }),
      UnexpectedDefect({ cause: 'private defect' }),
    ]) {
      const envelope = orThrow(serialize(failure, ID_GENERATION_FAILURES));
      const json = JSON.stringify(envelope);
      expect(json).not.toContain('private');
      const wire: unknown = JSON.parse(json);
      const revived = revive(wire, ID_GENERATION_FAILURES);
      expect(revived?.code).toBe(failure.code);
      if (isFailure(revived)) expect(revived.cause).toBeUndefined();
    }
  });
});

describe('UUID generation format', () => {
  const jobId = defineId('', { kind: 'queue.job', format: 'uuid' });
  const uuid = '01234567-89ab-4cde-8f01-23456789abcd';
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('generates UUID v4 and restores external keys without changing default generation', () => {
    expect(orThrow(jobId.create())).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(jobId.schema.parse('customer:job/42')).toBe('customer:job/42');
    expect(jobId.is('')).toBe(true);
    expect(jobId.schema.safeParse(42).success).toBe(false);
    expect(orThrow(defineId('', { kind: 'default' }).create())).toMatch(/^[a-z][a-z0-9]{23}$/);
  });

  it('retains the receiver, reads once, and preserves UUID bytes and prefixes', () => {
    const randomUUID = vi.fn(function (this: unknown) {
      expect(this).toBe(provider);
      return uuid;
    });
    const readMethod = vi.fn(() => randomUUID);
    const provider = Object.defineProperties(
      {},
      {
        randomUUID: { get: readMethod },
        getRandomValues: {
          get() {
            throw new Error('A native UUID must not read the fallback provider');
          },
        },
      },
    );
    vi.stubGlobal('crypto', provider);
    expect(defineId('job_', { kind: 'queue.job', format: 'uuid' }).create()).toBe(`job_${uuid}`);
    expect(readMethod).toHaveBeenCalledTimes(1);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, false, {}, { randomUUID: 1 }, { randomUUID: null, getRandomValues: 1 }])(
    'returns canonical unavailability for missing UUID provider %j',
    crypto => {
      vi.stubGlobal('crypto', crypto);
      const weakRandom = vi.spyOn(Math, 'random');
      expect(RandomSourceUnavailable.is(jobId.create())).toBe(true);
      expect(weakRandom).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, null, false, 1])('uses secure bytes when randomUUID is unavailable (%j)', randomUUID => {
    const getRandomValues = vi.fn(function (this: unknown, bytes: Uint8Array) {
      expect(this).toBe(provider);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.byteLength).toBe(16);
      bytes.set([1, 35, 69, 103, 137, 171, 205, 239, 1, 35, 69, 103, 137, 171, 205, 239]);
      return bytes;
    });
    const readMethod = vi.fn(() => getRandomValues);
    const provider = Object.defineProperty({ randomUUID }, 'getRandomValues', { get: readMethod });
    vi.stubGlobal('crypto', provider);
    const weakRandom = vi.spyOn(Math, 'random');
    expect(defineId('job_', { kind: 'queue.job', format: 'uuid' }).create()).toBe(
      'job_01234567-89ab-4def-8123-456789abcdef',
    );
    expect(readMethod).toHaveBeenCalledTimes(1);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(weakRandom).not.toHaveBeenCalled();
  });

  it.each([
    [0, '00000000-0000-4000-8000-000000000000'],
    [255, 'ffffffff-ffff-4fff-bfff-ffffffffffff'],
    [64, '40404040-4040-4040-8040-404040404040'],
    [128, '80808080-8080-4080-8080-808080808080'],
  ] as const)('sets only RFC 9562 version and variant bits for byte %i', (byte, expected) => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(byte) });
    expect(jobId.create()).toBe(expected);
  });

  it.each(['method getter', 'provider'])('keeps thrown fallback %s defects private', location => {
    const cause = new Error('private fallback details');
    const fail = () => {
      throw cause;
    };
    vi.stubGlobal(
      'crypto',
      location === 'method getter'
        ? Object.defineProperty({}, 'getRandomValues', { get: fail })
        : { getRandomValues: fail },
    );
    const result = jobId.create();
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!isFailure(result)) throw new Error('Expected UUID fallback defect');
    expect(result.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain('private fallback');
    expect({ ...result }).not.toHaveProperty('cause');
  });

  it.each([undefined, null, 42, {}, new Uint8Array(16)])('rejects foreign fallback output %j', output => {
    const getRandomValues = vi.fn(() => output);
    vi.stubGlobal('crypto', { getRandomValues });
    expect(UnexpectedDefect.is(jobId.create())).toBe(true);
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('reads only the fallback buffer indices even if its iterator or length is replaced', () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0);
        Object.defineProperty(bytes, Symbol.iterator, {
          value() {
            throw new Error('Do not iterate');
          },
        });
        Object.defineProperty(bytes, 'length', { value: Infinity });
        return bytes;
      },
    });
    expect(jobId.create()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('refuses a detached fallback buffer instead of returning a partial UUID', () => {
    vi.stubGlobal('crypto', {
      getRandomValues(bytes: Uint8Array) {
        const buffer = bytes.buffer;
        if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected a transferable array buffer');
        structuredClone(buffer, { transfer: [buffer] });
        return bytes;
      },
    });
    expect(UnexpectedDefect.is(jobId.create())).toBe(true);
  });

  it('observes asynchronous fallback protocol failures without retrying or exposing their causes', async () => {
    const readThen = vi.fn(() => {
      throw new Error('private fallback then getter');
    });
    for (const output of [
      Promise.reject(new Error('private fallback rejection')),
      Promise.resolve(new Uint8Array(16)),
      // eslint-disable-next-line unicorn/no-thenable -- Intentional malformed foreign protocol fixture.
      Object.defineProperty({}, 'then', { get: readThen }),
    ]) {
      const getRandomValues = vi.fn(() => output);
      vi.stubGlobal('crypto', { getRandomValues });
      const result = jobId.create();
      expect(UnexpectedDefect.is(result)).toBe(true);
      expect(JSON.stringify(result)).not.toContain('private fallback');
      expect(getRandomValues).toHaveBeenCalledTimes(1);
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readThen).toHaveBeenCalledTimes(1);
  });

  it.each(['global getter', 'method getter', 'provider'])('keeps thrown UUID %s defects private', location => {
    const cause = new Error('private UUID details');
    const fail = () => {
      throw cause;
    };
    if (location === 'global getter') vi.spyOn(globalThis, 'crypto', 'get').mockImplementation(fail);
    else
      vi.stubGlobal(
        'crypto',
        location === 'method getter'
          ? Object.defineProperty({}, 'randomUUID', { get: fail })
          : {
              randomUUID: fail,
              getRandomValues: () => {
                throw new Error('Do not retry native faults');
              },
            },
      );
    const result = jobId.create();
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!isFailure(result)) throw new Error('Expected UUID defect');
    expect(result.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain('private UUID');
    expect({ ...result }).not.toHaveProperty('cause');
  });

  it.each([
    undefined,
    null,
    42,
    'invalid',
    '01234567-89ab-1cde-8f01-23456789abcd',
    '01234567-89ab-4cde-7f01-23456789abcd',
  ])('rejects invalid UUID output %j', output => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0));
    vi.stubGlobal('crypto', { randomUUID: () => output, getRandomValues });
    expect(UnexpectedDefect.is(jobId.create())).toBe(true);
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('observes rejected promises and hostile thenables as synchronous protocol defects', async () => {
    const readThen = vi.fn(() => {
      throw new Error('private then getter');
    });
    for (const output of [
      Promise.reject(new Error('private UUID rejection')),
      Promise.resolve(uuid),
      // eslint-disable-next-line unicorn/no-thenable -- Intentional malformed foreign protocol fixture.
      Object.defineProperty({}, 'then', { get: readThen }),
    ]) {
      const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(0));
      vi.stubGlobal('crypto', { randomUUID: () => output, getRandomValues });
      expect(UnexpectedDefect.is(jobId.create())).toBe(true);
      expect(getRandomValues).not.toHaveBeenCalled();
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(readThen).toHaveBeenCalledTimes(1);
  });

  it.each(['cuid', null, 42])('rejects unsupported static generation format %j', format => {
    expect(() => Reflect.apply(defineId, null, ['', { kind: 'queue.job', format }])).toThrow('ARKI_CONTRACTS_E010');
  });
});
