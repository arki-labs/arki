import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { IdGenerationFailure } from '@arki/contracts';
import { RandomSourceUnavailable } from '@arki/contracts';
import { UnexpectedDefect } from '@arki/failure';

import * as factoryEntry from './id-factory.js';
import { createId, createIdFactory, createPrefixedId } from './id.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('legacy ID generation', () => {
  it('both public entries share the same supervised implementation', () => {
    expect(createId).toBe(factoryEntry.createId);
    expect(createPrefixedId).toBe(factoryEntry.createPrefixedId);
    expect(createIdFactory).toBe(factoryEntry.createIdFactory);
  });

  it('preserves the unprefixed stored format', () => {
    expectTypeOf(createId()).toEqualTypeOf<string | IdGenerationFailure>();
    expect(createId()).toMatch(/^[a-z][a-z0-9]{23}$/);
  });

  it.each(['pt', 'usr_', '', 'legacy:/'])('keeps prefix %j and the existing validation contract', prefix => {
    const factory = createIdFactory(prefix);
    const result = factory.create();
    expect(typeof result).toBe('string');
    if (typeof result !== 'string') throw new Error('Expected secure generation to succeed');
    expect(result.slice(0, prefix.length)).toBe(prefix);
    expect(result.slice(prefix.length)).toMatch(/^[a-z][a-z0-9]{23}$/);
    expect(factory.schema.parse(result)).toBe(result);
    // Stored legacy schemas accepted arbitrary suffixes, even the empty suffix.
    expect(factory.schema.parse(prefix)).toBe(prefix);
    expect(factory.make).toBe(factory.create);
    expect(factory.new).toBe(factory.create);
  });

  it('keeps failure unions exact without contaminating successful schemas', () => {
    expectTypeOf(createPrefixedId('row_')).toEqualTypeOf<`row_${string}` | IdGenerationFailure>();
    const unprefixed = createIdFactory('');
    expectTypeOf(unprefixed.create()).toEqualTypeOf<string | IdGenerationFailure>();
    expectTypeOf(unprefixed.schema.parse('stored')).toEqualTypeOf<string>();
  });

  it('returns missing entropy through every alias without concatenating it or using Math.random', () => {
    const fallback = vi.spyOn(Math, 'random');
    vi.stubGlobal('crypto', null);
    const factory = createIdFactory('row_');
    for (const result of [createId(), createPrefixedId('row_'), factory.create(), factory.make(), factory.new()]) {
      expect(RandomSourceUnavailable.is(result)).toBe(true);
    }
    expect(fallback).not.toHaveBeenCalled();
  });

  it('supervises provider faults and retains private causes', () => {
    const cause = new Error('private entropy provider failure');
    vi.stubGlobal('crypto', {
      getRandomValues() {
        throw cause;
      },
    });
    const result = createIdFactory('row_').create();
    expect(UnexpectedDefect.is(result)).toBe(true);
    if (!UnexpectedDefect.is(result)) throw new Error('Expected the canonical defect');
    expect(result.cause).toBe(cause);
    expect(JSON.stringify(result)).not.toContain(cause.message);
  });
});
