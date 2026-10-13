import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { CaseResult, SizeSpec } from '../core/types.js';
import { createSizeRunner } from './size.js';

const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore' }).error === undefined;

const dir = mkdtempSync(path.join(tmpdir(), 'arki-bench-size-'));
writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'size-fixture', type: 'module' }));
writeFileSync(path.join(dir, 'style.css'), '.button { color: rebeccapurple; padding: 4px 8px; }\n');
writeFileSync(path.join(dir, 'small.js'), "import './style.css';\nexport const small = n => n + 1;\n");
writeFileSync(
  path.join(dir, 'large.js'),
  `export const large = n => {\n${Array.from({ length: 60 }, (_, index) => `  n = (n * ${index + 3} + ${index * 7}) % 1000003;`).join('\n')}\n  return n;\n};\n`,
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Entries are written to <root>/.cache/bench-size/, two levels below the fixture files.
const group: SizeSpec = {
  kind: 'size',
  id: 'button',
  title: 'Button',
  baseline: 'small',
  cases: {
    small: { source: "export { small } from '../../small.js';", limit: '1 kB' },
    large: { source: "export { large } from '../../large.js';", limit: '10 B' },
  },
};

function caseOf(cases: readonly CaseResult[], key: string): CaseResult {
  const found = cases.find(item => item.key === key);
  if (!found) throw new Error(`case ${key} missing`);
  return found;
}

describe.skipIf(!hasBun)('createSizeRunner (needs bun on PATH)', () => {
  it('counts every file a consumer downloads — JS and the CSS it imports — compressed one by one', async () => {
    const result = await createSizeRunner({ cwd: dir })(group);
    const small = caseOf(result.cases, 'small');
    const size = small.size;
    if (!size) throw new Error('no size');

    expect(size.files.map(file => path.extname(file.path)).toSorted()).toEqual(['.css', '.js']);
    expect(size.raw).toBe(size.files.reduce((sum, file) => sum + file.raw, 0));
    expect(size.gzip).toBe(size.files.reduce((sum, file) => sum + file.gzip, 0));
    expect(size.brotli).toBe(size.files.reduce((sum, file) => sum + file.brotli, 0));
    expect(size.files.every(file => file.gzip > 0 && file.brotli > 0)).toBe(true);
    // Measured once and exact: the summary is the gzip total with a zero-width interval.
    expect(small.summary).toMatchObject({ estimate: size.gzip, interval: [size.gzip, size.gzip], n: 1 });
    expect(size.contributors?.map(item => item.path)).toContain('small.js');
    expect(small.role).toBe('baseline');
  }, 30_000);

  it('enforces the gzip budget and ranks by gzip total against the baseline', async () => {
    const result = await createSizeRunner({ cwd: dir })(group);
    const small = caseOf(result.cases, 'small');
    const large = caseOf(result.cases, 'large');

    expect(small.limit).toBe(1000);
    expect(small.flags).toEqual([]);
    expect(large.limit).toBe(10);
    expect(large.flags).toEqual(['over-limit']);

    const ratio = (large.size?.gzip ?? 0) / (small.size?.gzip ?? 1);
    expect(result.comparisons).toEqual([
      { case: 'large', ratio, interval: [ratio, ratio], verdict: ratio > 1.02 ? 'higher' : 'tie' },
    ]);
    expect(result.unit).toBe('bytes');
  }, 30_000);

  // Another entry point of the baseline's own library is not a rival: it keeps its
  // ratio (how much the extra entry costs) but is labelled, while `differs` rows get none.
  it('labels variants and keeps their ratio; differs rows get no ratio', async () => {
    const result = await createSizeRunner({ cwd: dir })({
      ...group,
      cases: {
        small: group.cases.small!,
        both: {
          source: "export { small } from '../../small.js';\nexport { large } from '../../large.js';",
          variant: true,
        },
        large: { source: "export { large } from '../../large.js';", differs: 'other API' },
      },
    });
    expect(caseOf(result.cases, 'both').role).toBe('variant');
    expect(caseOf(result.cases, 'large').role).toBe('differs');
    expect(result.comparisons.map(row => row.case)).toEqual(['both']);
  }, 30_000);
});

describe.skipIf(!hasBun)('size externals (needs bun on PATH)', () => {
  // A package that guards `import 'bun:jsc'` at runtime (mitata does) must still bundle for the browser.
  writeFileSync(
    path.join(dir, 'guarded.js'),
    "import { gcAndSweep } from 'bun:jsc';\nexport const collect = () => (typeof Bun === 'undefined' ? 0 : gcAndSweep());\n",
  );
  const guarded = (externals?: readonly string[]): SizeSpec => ({
    kind: 'size',
    id: 'guarded',
    title: 'Guarded',
    baseline: 'g',
    ...(externals === undefined ? {} : { externals }),
    cases: { g: { source: "export { collect } from '../../guarded.js';" } },
  });

  it('leaves bun:* modules out by default', async () => {
    const result = await createSizeRunner({ cwd: dir })(guarded());
    expect(result.cases.map(item => item.key)).toEqual(['g']);
  });

  it('lets a group replace the default externals entirely', async () => {
    await expect(createSizeRunner({ cwd: dir })(guarded(['react']))).rejects.toThrow(/bun:jsc/);
  });
});

// Under Bun the bundler is in-process, so a missing `bun` binary cannot happen there.
describe.skipIf(Reflect.has(globalThis, 'Bun'))('createSizeRunner without bun', () => {
  it('returns the group unmeasured with a warning instead of failing the run', async () => {
    vi.stubEnv('PATH', path.dirname(process.execPath));
    try {
      const result = await createSizeRunner({ cwd: dir })(group);
      expect(result.cases).toEqual([]);
      expect(result.warnings).toEqual([expect.objectContaining({ code: 'size-unavailable', group: 'button' })]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
