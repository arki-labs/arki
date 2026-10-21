import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NpmRunner } from './runners';
import { checkGuide, GUIDE_ERROR_CODES, hasGuideMarker, nextMinor, publishedApiDiff, renderGuide, runUpgradeGuide } from './upgrade-guide';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'arki-guide-'));
  mkdirSync(path.join(root, 'packages', 'env'), { recursive: true });
  writeFileSync(path.join(root, 'packages', 'env', 'package.json'), JSON.stringify({ name: '@arki/env', version: '0.1.0' }));
  mkdirSync(path.join(root, '.changeset'));
  writeFileSync(path.join(root, '.changeset', 'env-minor.md'), "---\n'@arki/env': minor\n---\n\nAdd `defineEnv` strict mode.\n");
  writeFileSync(path.join(root, '.changeset', 'env-patch.md'), "---\n'@arki/env': patch\n---\n\nFix a typo.\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const file = () => path.join(root, 'packages', 'env', 'docs', 'upgrades', '0.1.0-to-0.2.0.md');

describe('upgrade-guide', () => {
  it('builds a skeleton from the minor changesets only, with markers to fill', async () => {
    // Why: the guide starts from what authors already wrote; patch notes
    // would bury the changes users must act on.
    const envelope = await runUpgradeGuide({ root, pkg: 'env', from: '0.1.0', to: '0.2.0', write: false });
    const content = envelope.items[0]?.content ?? '';
    expect(content).toContain('# Upgrade @arki/env 0.1.0 to 0.2.0');
    expect(content).toContain('- Add `defineEnv` strict mode.');
    expect(content).not.toContain('typo');
    expect(hasGuideMarker(content)).toBe(true);
    expect(existsSync(file())).toBe(false);
  });

  it('writes the file with --write and refuses to overwrite a guide a person edited', async () => {
    // Why: a second run must never destroy the human text in a finished guide.
    const first = await runUpgradeGuide({ root, pkg: '@arki/env', from: '0.1.0', to: '0.2.0', write: true });
    expect(first.items[0]?.written).toBe(true);
    expect(await checkGuide(root, 'packages/env', '0.1.0', '0.2.0')).toBe('unfinished');
    writeFileSync(file(), '# Done\n');
    expect(await checkGuide(root, 'packages/env', '0.1.0', '0.2.0')).toBe('ok');
    const second = await runUpgradeGuide({ root, pkg: 'env', from: '0.1.0', to: '0.2.0', write: true });
    expect(second.errors[0]?.code).toBe(GUIDE_ERROR_CODES.exists);
    expect(readFileSync(file(), 'utf8')).toBe('# Done\n');
  });

  it('renders the api diff section when one is given', () => {
    // Why: removed and changed names are the breaking part users search for.
    const text = renderGuide({
      pkg: '@arki/env',
      from: '0.1.0',
      to: '0.2.0',
      changesets: [],
      apiDiff: {
        added: [{ subpath: './client', name: 'strict', kind: 'function', signature: 'x', jsdocSummary: '' }],
        removed: [{ subpath: '.', name: 'old', kind: 'variable', signature: 'y', jsdocSummary: '' }],
        changed: [{ subpath: '.', name: 'defineEnv', from: '(a)', to: '(a, b)' }],
        changedGroups: [],
      },
    });
    expect(text).toContain('- `old` from `@arki/env` (variable)');
    expect(text).toContain('- `defineEnv` from `@arki/env`\n  - before: `(a)`\n  - after: `(a, b)`');
    expect(text).toContain('- `strict` from `@arki/env/client` (function)');
  });

  it('produces no diff, and asks npm nothing, when a subpath of the local package is not built', async () => {
    // Why: an unbuilt subpath has no names, so a diff would list every name as removed and mislead users.
    const dir = path.join(root, 'packages', 'env');
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@arki/env', version: '0.1.0', exports: { '.': { types: './dist/index.d.ts' } } }));
    const asked: string[] = [];
    const npm: NpmRunner = async args => {
      asked.push(args.join(' '));
      return { code: 1, stdout: '', stderr: 'E404' };
    };
    expect(await publishedApiDiff({ pkg: '@arki/env', from: '0.1.0', packageDir: dir, npm })).toBeNull();
    expect(asked).toEqual([]);
    const envelope = await runUpgradeGuide({ root, pkg: 'env', from: '0.1.0', to: '0.2.0', write: false, npm });
    expect(envelope.items[0]?.apiDiff).toBe('none');
  });

  it('predicts the next minor', () => {
    // Why: dry-run ship checks the guide before the version exists.
    expect(nextMinor('0.3.4')).toBe('0.4.0');
    expect(nextMinor('x')).toBeNull();
  });
});
