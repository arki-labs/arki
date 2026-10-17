/**
 * The parser against the three real shapes. Each case is a way a user types
 * argv that a CLI has gotten wrong before: a negative number read as a flag,
 * a flag eating the next flag, `1e3` passing as an integer, a scalar given
 * twice silently keeping the last value.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { benchInput, helloInput, seedArgs, seedInput } from './__fixtures__/shapes.js';
import { flagsOf, GLOBAL_FLAGS } from './flags.js';
import { parse } from './parse.js';

const hello = flagsOf(helloInput);
const seed = flagsOf(seedInput, seedArgs);
const bench = flagsOf(benchInput);

function value(result: ReturnType<typeof parse>): Readonly<Record<string, unknown>> {
  if (!result.ok) throw new Error(result.issues.map(issue => issue.message).join('; '));
  return result.value;
}

function messages(result: ReturnType<typeof parse>): readonly string[] {
  return result.ok ? [] : result.issues.map(issue => issue.message);
}

describe('flagsOf', () => {
  it('reads one spec per property, with kebab flags, kinds, choices and help text', () => {
    expect(seed).toEqual([
      expect.objectContaining({
        key: 'maxBatches',
        flag: 'max-batches',
        kind: 'integer',
        position: 0,
        required: false,
      }),
      expect.objectContaining({ key: 'yes', flag: 'yes', kind: 'boolean', position: undefined, required: false }),
    ]);
    expect(bench[1]).toMatchObject({ key: 'category', array: true, kind: 'string', variadic: false });
    expect(bench[1]?.choices).toContain('refusal');
    expect(hello[0]?.description).toBe('Who to greet');
  });

  it('rejects args that name a missing key: a typo must fail at definition, not at run time', () => {
    expect(() => flagsOf(seedInput, ['maxBatch'])).toThrow(/not a key/);
  });
});

describe('hello', () => {
  it('takes --name value and --name=value alike', () => {
    expect(value(parse(hello, ['--name', 'Ada']))).toEqual({ name: 'Ada' });
    expect(value(parse(hello, ['--name=Ada']))).toEqual({ name: 'Ada' });
  });

  it('leaves an absent optional flag out, so the schema decides', () => {
    expect(value(parse(hello, []))).toEqual({});
  });

  it('fails an unknown flag instead of ignoring a typo', () => {
    expect(messages(parse(hello, ['--nmae', 'Ada']))).toContain('Unknown flag --nmae');
  });

  it('fails --no-x on a non-boolean as unknown', () => {
    expect(messages(parse(hello, ['--no-name']))).toEqual(['Unknown flag --no-name']);
  });

  it('fails a scalar given twice instead of keeping the last', () => {
    expect(messages(parse(hello, ['--name', 'a', '--name', 'b']))).toEqual(['--name given more than once']);
  });

  it('does not let a flag eat the next flag as its value', () => {
    expect(messages(parse(hello, ['--name', '--nmae']))[0]).toMatch(/--name needs a value/);
    expect(value(parse(hello, ['--name=--odd']))).toEqual({ name: '--odd' });
  });

  it('accepts a negative number as a string value', () => {
    expect(value(parse(hello, ['--name', '-5']))).toEqual({ name: '-5' });
  });

  it('fails a flag with no value at the end', () => {
    expect(messages(parse(hello, ['--name']))).toEqual(['--name needs a value']);
  });
});

describe('seed', () => {
  it('maps the positional and the boolean', () => {
    expect(value(parse(seed, ['3', '--yes']))).toEqual({ maxBatches: 3, yes: true });
    expect(value(parse(seed, ['--no-yes']))).toEqual({ yes: false });
  });

  it('accepts the positional key as a flag too', () => {
    expect(value(parse(seed, ['--max-batches', '7']))).toEqual({ maxBatches: 7 });
  });

  it('fails the positional and its flag together as a duplicate', () => {
    expect(messages(parse(seed, ['--max-batches', '7', '8']))).toEqual(['<max-batches> given more than once']);
  });

  it('reads a negative number as the positional, not a flag; range is the schema job', () => {
    const raw = value(parse(seed, ['-5']));
    expect(raw).toEqual({ maxBatches: -5 });
    expect(seedInput.safeParse(raw).success).toBe(false);
  });

  it('rejects 1.5, 1e3 and 2junk as integers', () => {
    expect(messages(parse(seed, ['1.5']))).toEqual(['<max-batches> expected an integer, received "1.5"']);
    expect(messages(parse(seed, ['1e3']))).toEqual(['<max-batches> expected an integer, received "1e3"']);
    expect(messages(parse(seed, ['--max-batches', '2junk']))).toEqual([
      '--max-batches expected an integer, received "2junk"',
    ]);
  });

  it('accepts a value on a boolean with =, and nothing else', () => {
    expect(value(parse(seed, ['--yes=false']))).toEqual({ yes: false });
    expect(messages(parse(seed, ['--yes=maybe']))).toEqual(['--yes expected true or false, received "maybe"']);
  });

  it('reads `--yes false` as --yes then a positional, which fails as an integer', () => {
    expect(messages(parse(seed, ['--yes', 'false']))).toEqual(['<max-batches> expected an integer, received "false"']);
  });

  it('stops reading flags after --', () => {
    expect(messages(parse(seed, ['--', '--yes']))).toEqual(['<max-batches> expected an integer, received "--yes"']);
    expect(value(parse(seed, ['--yes', '--', '-5']))).toEqual({ yes: true, maxBatches: -5 });
  });

  it('fails an extra positional', () => {
    expect(messages(parse(seed, ['1', '2']))).toEqual(['Unexpected argument "2"']);
  });

  it('collects every issue, not just the first', () => {
    expect(messages(parse(seed, ['x', '--nope', '--yes=2']))).toHaveLength(3);
  });

  it('gives the schema a raw object it validates and fills defaults into', () => {
    expect(seedInput.parse(value(parse(seed, ['2'])))).toEqual({ maxBatches: 2, yes: false });
  });
});

describe('bench', () => {
  it('reads a repeated flag and a comma list as the same array', () => {
    const repeated = value(parse(bench, ['--category', 'refusal', '--category', 'routing']));
    const comma = value(parse(bench, ['--category', 'refusal,routing']));
    const mixed = value(parse(bench, ['--category=refusal', '--category', 'routing']));
    expect(repeated).toEqual({ category: ['refusal', 'routing'] });
    expect(comma).toEqual(repeated);
    expect(mixed).toEqual(repeated);
  });

  it('leaves the default to validation: no --label in the raw object, latest after parse', () => {
    const raw = value(parse(bench, []));
    expect(raw).toEqual({});
    expect(benchInput.parse(raw)).toEqual({ label: 'latest' });
  });

  it('passes an unknown category through to the schema, which rejects it', () => {
    const raw = value(parse(bench, ['--category', 'nope']));
    expect(benchInput.safeParse(raw).success).toBe(false);
  });

  it('fails --label twice but allows --category twice', () => {
    expect(
      messages(parse(bench, ['--label', 'a', '--label=b', '--category', 'refusal', '--category', 'routing'])),
    ).toEqual(['--label given more than once']);
  });

  it('fails a short flag: command flags have no short alias', () => {
    expect(messages(parse(bench, ['-l', 'x']))).toEqual(['Unknown flag -l', 'Unexpected argument "x"']);
  });
});

describe('global flags', () => {
  const withGlobals = [...GLOBAL_FLAGS, ...seed];

  it('takes -o json, -q and -h as the short forms of their long flags', () => {
    expect(value(parse(withGlobals, ['-o', 'json', '-q', '-h']))).toEqual({ output: 'json', quiet: true, help: true });
  });

  it('expands a short group: -qh is -q -h', () => {
    expect(value(parse(withGlobals, ['-qh']))).toEqual({ quiet: true, help: true });
  });

  it('fails a short flag no spec declares, even when a long flag has that letter', () => {
    expect(messages(parse(withGlobals, ['-y']))).toEqual(['Unknown flag -y']);
  });

  it('reads --no-color as color false', () => {
    expect(value(parse(withGlobals, ['--no-color']))).toEqual({ color: false });
  });

  it('keeps command flags and global flags in one pass', () => {
    expect(value(parse(withGlobals, ['7', '--yes', '--json', '--fields', 'a,b.c']))).toEqual({
      maxBatches: 7,
      yes: true,
      json: true,
      fields: 'a,b.c',
    });
  });

  it('still fails 2junk as an integer next to global flags', () => {
    expect(messages(parse(withGlobals, ['2junk', '--json']))).toEqual([
      '<max-batches> expected an integer, received "2junk"',
    ]);
  });

  it('rejects an input key that collides with a global flag, naming it: a silent shadow would change --json for one command', () => {
    expect(() => flagsOf(z.object({ json: z.boolean() }))).toThrow(/"json" collides with the global flag --json/);
    expect(() => flagsOf(z.object({ dryRun: z.boolean() }))).toThrow(/--dry-run/);
  });
});
