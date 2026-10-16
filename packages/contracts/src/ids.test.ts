import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod/v4';

import type { IdOf } from './ids.js';
import { assertUniqueIdPrefixes, defineId, userIdSchema } from './ids.js';

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
    expectTypeOf(storyId.create()).toEqualTypeOf<StoryId>();
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
    const ids = Array.from({ length: 500 }, () => storyId.create());
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

  it('rejects a prefix with characters that would need escaping in URLs or SQL', () => {
    expect(() => defineId('st y_')).toThrow(TypeError);
    expect(() => defineId('')).toThrow(TypeError);
  });

  it('is browser-safe: the schema exports a JSON Schema pattern a client can check', () => {
    expect(z.toJSONSchema(storyId.schema)).toMatchObject({ type: 'string', pattern: '^sty_[\\s\\S]{0,}$' });
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
      defineId('bad prefix');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(TypeError);
    expect(caught).toMatchObject({ name: 'ContractsError', code: 'ARKI_CONTRACTS_E001' });
    expect(caught).toHaveProperty('remediation', expect.stringContaining('letters'));
  });
});
