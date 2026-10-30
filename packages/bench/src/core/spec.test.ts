import { describe, expect, it } from 'vitest';

import type { CompareSpec, GroupSpec, SuiteSpec } from './types.js';
import {
  compare,
  defineSuite,
  metric,
  parseSize,
  scenario,
  size,
  SpecError,
  specHash,
  validateSuite,
  workHash,
} from './spec.js';

const addGroup = (): CompareSpec<unknown> =>
  compare({
    id: 'add',
    title: 'Add one',
    contract: { id: 'add/v1', description: 'n + 1' },
    inputs: [1, 2],
    baseline: 'a',
    cases: { a: { run: (n: unknown) => Number(n) + 1 }, b: { run: (n: unknown) => Number(n) + 1 } },
  });

function problemsOf(suite: SuiteSpec): readonly string[] {
  try {
    validateSuite(suite);
  } catch (error) {
    if (error instanceof SpecError) return error.problems;
    throw error;
  }
  return [];
}

describe('compare() typing', () => {
  it('flows setup → run → normalize per case, so each library keeps its own state type', () => {
    const group = compare({
      id: 'round',
      title: 'Round',
      contract: { id: 'round/v1', description: 'round to 2 decimals' },
      inputs: [1.005, 2.5],
      baseline: 'text',
      cases: c => ({
        // The state is a string here and an object below: both are checked, neither is `unknown`.
        text: c({ setup: n => n.toFixed(3), run: s => s.slice(0, -1), normalize: r => Number(r) }),
        boxed: c({
          setup: n => ({ cents: Math.round(n * 1000) }),
          run: s => s.cents / 1000,
          normalize: r => r.toFixed(2),
        }),
        // @ts-expect-error run() must accept what setup() returns
        wrong: c({ setup: n => String(n), run: (s: number) => s }),
      }),
    });
    expect(group.kind).toBe('compare');
    expect(Object.keys(group.cases)).toEqual(['text', 'boxed', 'wrong']);
    expect(group.cases.text!.run('1.005')).toBe('1.00');
  });

  it('scenario(), size() and metric() set their kind', () => {
    const s = scenario({
      id: 's',
      title: 'S',
      cases: c => ({ x: c({ setup: () => [1, 2], run: list => list.length }) }),
    });
    expect(s.kind).toBe('scenario');
    expect(size({ id: 'z', title: 'Z', baseline: 'a', cases: { a: { source: 'export {}' } } }).kind).toBe('size');
    expect(
      metric({ id: 'm', title: 'M', unit: 'x', deterministic: true, baseline: 'a', cases: { a: { collect: () => 1 } } })
        .kind,
    ).toBe('metric');
  });
});

describe('validateSuite', () => {
  it('accepts a sound suite', () => {
    expect(problemsOf(defineSuite({ id: '@arki/x', groups: [addGroup()] }))).toEqual([]);
  });

  it('reports every problem at once, so one run fixes the whole file', () => {
    const suite = defineSuite({
      id: 'x',
      groups: [
        addGroup(),
        addGroup(), // duplicate id
        compare({
          id: 'Bad Id',
          title: 't',
          contract: { id: 'Contract!', description: 'd' },
          inputs: [],
          baseline: 'missing',
          cases: { only: { run: (n: unknown) => n } },
        }),
        compare({
          id: 'differs-base',
          title: 't',
          contract: { id: 'c', description: 'd' },
          inputs: [1],
          baseline: 'a',
          cases: { a: { run: (n: unknown) => n, differs: 'rounds up' }, b: { run: (n: unknown) => n } },
        }),
        compare({
          id: 'variant-base',
          title: 't',
          contract: { id: 'c', description: 'd' },
          inputs: [1],
          baseline: 'a',
          cases: { a: { run: (n: unknown) => n, variant: true }, b: { run: (n: unknown) => n } },
        }),
        size({ id: 'size', title: 's', baseline: 'a', cases: { a: { source: 'export {}', limit: 'eight kB' } } }),
        metric({
          id: 'metric',
          title: 'm',
          unit: 'x',
          deterministic: true,
          baseline: 'nope',
          cases: { a: { collect: () => 1 } },
        }),
        scenario({ id: 'scenario', title: 's', inputs: [], cases: { a: { run: () => 1 } } }),
      ],
    });
    const problems = problemsOf(suite);
    const expectations = [
      /"add" is used more than once/,
      /Group id "Bad Id" is not a valid id/,
      /contract id "Contract!" is not a valid id/,
      /"Bad Id": baseline "missing" is not one of its cases/,
      /"Bad Id": `inputs` is empty/,
      /"Bad Id" has 1 case\(s\) that keep the contract/,
      /"differs-base": the baseline "a" cannot be marked `differs`/,
      /"differs-base" has 1 case\(s\)/,
      /"variant-base": the baseline "a" cannot be marked `variant`/,
      /limit "eight kB" is not a number followed by a unit/,
      /"metric": baseline "nope" is not one of its cases/,
      /"scenario": `inputs` is empty/,
    ];
    for (const pattern of expectations)
      expect(
        problems.some(problem => pattern.test(problem)),
        String(pattern),
      ).toBe(true);
    expect(problems).toHaveLength(expectations.length);
    expect(() => validateSuite(suite)).toThrow(/12 problems/);
  });

  it('requires a baseline on compare groups', () => {
    const group = { ...addGroup(), baseline: '' };
    expect(problemsOf({ id: 'x', groups: [group] })).toEqual([expect.stringMatching(/has no baseline/)]);
  });
});

describe('parseSize', () => {
  it('reads decimal and binary units', () => {
    expect(parseSize('8 kB')).toEqual({ bytes: 8000 });
    expect(parseSize('1.5MB')).toEqual({ bytes: 1_500_000 });
    expect(parseSize('10 KiB')).toEqual({ bytes: 10_240 });
    expect(parseSize('512 B')).toEqual({ bytes: 512 });
  });

  it('says which part did not parse, so the caller can show a reason', () => {
    expect(parseSize('8')).toEqual({ problem: expect.stringContaining('not a number followed by a unit') });
    expect(parseSize('8 parsecs')).toEqual({ problem: expect.stringContaining('unknown unit "parsecs"') });
  });
});

describe('specHash', () => {
  const suite = (groups: readonly GroupSpec[], title = 'T'): SuiteSpec => ({ id: 'x', title, groups });

  it('is stable and hex', () => {
    const hash = specHash(suite([addGroup()]));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(specHash(suite([addGroup()]))).toBe(hash);
    expect(specHash(suite([addGroup()], 'Another suite title'))).toBe(hash);
  });

  it('ignores function bodies, so Node, Bun and Deno (which print source differently) agree and a code-only change keeps the baseline', () => {
    const hash = specHash(suite([addGroup()]));
    const changed = addGroup();
    const rewritten = { ...changed, cases: { ...changed.cases, b: { run: (n: unknown) => 1 + Number(n) } } };
    expect(specHash(suite([rewritten]))).toBe(hash);
    expect(specHash(suite([{ ...changed, expected: (n: unknown) => Number(n) + 1 }]))).toBe(hash);
  });

  it('changes when the declared work changes: the contract id is the "work changed" signal', () => {
    const hash = specHash(suite([addGroup()]));
    expect(specHash(suite([{ ...addGroup(), contract: { id: 'add/v2', description: 'n + 1' } }]))).not.toBe(hash);
    expect(specHash(suite([{ ...addGroup(), inputs: [1, 3] }]))).not.toBe(hash);
    expect(specHash(suite([{ ...addGroup(), baseline: 'b' }]))).not.toBe(hash);
    expect(specHash(suite([{ ...addGroup(), title: 'Renamed' }]))).not.toBe(hash);
  });

  it('does not depend on case order', () => {
    const group = addGroup();
    const reversed = { ...group, cases: { b: group.cases.b!, a: group.cases.a! } };
    expect(specHash(suite([reversed]))).toBe(specHash(suite([group])));
  });

  it('hashes inputs that JSON cannot represent, independent of key order', () => {
    const big = compare({ ...addGroup(), inputs: [1n, Number.NaN, undefined, -0] });
    expect(specHash(suite([big]))).not.toBe(
      specHash(suite([compare({ ...addGroup(), inputs: [1n, Number.NaN, undefined, 0] })])),
    );
    const a = compare({ ...addGroup(), inputs: [{ x: 1, y: 2 }] });
    const b = compare({ ...addGroup(), inputs: [{ y: 2, x: 1 }] });
    expect(specHash(suite([a]))).toBe(specHash(suite([b])));
    const opaque = compare({ ...addGroup(), inputs: [() => 1, () => 2] });
    expect(specHash(suite([opaque]))).toBe(specHash(suite([compare({ ...addGroup(), inputs: [() => 3, () => 4] })])));
  });
  it('never confuses a value with its text form or a lookalike', () => {
    // Each pair collided under the old JSON-replacer encoding; a changed input must change the hash.
    const withInputs = (inputs: readonly unknown[]): string => specHash(suite([compare({ ...addGroup(), inputs })]));
    const pairs: [unknown, unknown][] = [
      [1n, '1n'],
      [undefined, '(undefined)'],
      [-0, '(-0)'],
      [Number.NaN, '(NaN)'],
      [new Date(5), { '(Date)': 5 }],
      [new Date(0), '1970-01-01T00:00:00.000Z'],
      [new Map([['a', 1]]), { '(Map)': [['a', 1]] }],
      [new Set([1]), { '(Set)': [1] }],
      [JSON.parse('{"__proto__": 1}'), {}],
      [[undefined], [null]],
      [new Uint8Array([1]), [1]],
    ];
    for (const [left, right] of pairs) expect(withInputs([left])).not.toBe(withInputs([right]));
  });

  it('hashes cyclic inputs without throwing', () => {
    const cycle: { self?: unknown } = {};
    cycle.self = cycle;
    expect(specHash(suite([compare({ ...addGroup(), inputs: [cycle] })]))).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('workHash', () => {
  const group = addGroup();
  const hash = workHash(group, 'b');

  it('ignores what does not change the work: labels, titles, notes, packages, limits and other cases', () => {
    // Adding a competitor or renaming a label must not make every old baseline incompatible.
    const relabeled = {
      ...group,
      title: 'Renamed',
      note: 'n',
      cases: { ...group.cases, b: { ...group.cases.b!, label: 'B!', package: 'b-lib' }, c: group.cases.a! },
    };
    expect(workHash(relabeled, 'b')).toBe(hash);
    const sized = size({ id: 's', title: 'S', baseline: 'a', cases: { a: { source: 'x', limit: '1 kB' } } });
    expect(workHash({ ...sized, cases: { a: { source: 'x', limit: '9 kB', label: 'A' } } }, 'a')).toBe(
      workHash(sized, 'a'),
    );
  });

  it('changes with what does: contract id, mode, inputs, the case key and its differs/variant/source', () => {
    expect(workHash({ ...group, contract: { id: 'add/v2', description: 'n + 1' } }, 'b')).not.toBe(hash);
    expect(workHash({ ...group, mode: 'async' }, 'b')).not.toBe(hash);
    expect(workHash({ ...group, inputs: [1, 3] }, 'b')).not.toBe(hash);
    expect(workHash(group, 'a')).not.toBe(hash);
    expect(workHash({ ...group, cases: { ...group.cases, b: { ...group.cases.b!, variant: true } } }, 'b')).not.toBe(
      hash,
    );
    const sized = size({ id: 's', title: 'S', baseline: 'a', cases: { a: { source: 'x' } } });
    expect(workHash({ ...sized, cases: { a: { source: 'y' } } }, 'a')).not.toBe(workHash(sized, 'a'));
    expect(workHash({ ...sized, externals: [] }, 'a')).not.toBe(workHash(sized, 'a'));
  });
});

describe('ids', () => {
  it('accepts camelCase case keys, because they are the natural JavaScript object keys', () => {
    const group = compare({
      id: 'multiplyHalfEven',
      title: 'Multiply',
      contract: { id: 'vat/v1', description: 'n × 2' },
      inputs: [1],
      baseline: 'arki',
      cases: {
        arki: { run: (n: number) => n * 2 },
        arkiString: { run: (n: number) => n + n, variant: true },
        other: { run: (n: number) => 2 * n },
      },
    });
    expect(() => validateSuite(defineSuite({ id: '@arki/money', groups: [group] }))).not.toThrow();
  });
  it('checks the suite id like a group id (an npm scope allowed), so it can never break the README meta comment', () => {
    expect(problemsOf(defineSuite({ id: 'money', groups: [addGroup()] }))).toEqual([]);
    expect(problemsOf(defineSuite({ id: '@arki/money', groups: [addGroup()] }))).toEqual([]);
    expect(problemsOf(defineSuite({ id: 'x --> <script>', groups: [addGroup()] }))[0]).toMatch(
      /Suite id .* is not a valid id/,
    );
  });
});
