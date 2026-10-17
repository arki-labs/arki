import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCopyPlan } from './files';

describe('buildCopyPlan', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'arki-release-files-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('drops files negated in package.json files', async () => {
    // Why: the public mirror must carry what npm ships; a folder negated with
    // "!docs/plans/**" is private and would otherwise be published on GitHub.
    mkdirSync(path.join(tmp, 'docs', 'plans'), { recursive: true });
    writeFileSync(path.join(tmp, 'docs', 'guide.md'), 'guide');
    writeFileSync(path.join(tmp, 'docs', 'plans', 'next.md'), 'plan');
    const plan = await buildCopyPlan({
      packageSourceDir: tmp,
      packageDestDir: '/out',
      manifestFiles: ['docs', '!docs/plans/**'],
    });
    expect(plan.map(entry => path.relative(tmp, entry.src))).toEqual([path.join('docs', 'guide.md')]);
  });
});
