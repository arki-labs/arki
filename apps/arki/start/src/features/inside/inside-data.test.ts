import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import packagesFile from '~/generated/packages.json';
import { insideGroups } from './inside-data';

const rows = insideGroups.flatMap(group => [...group.rows]);
const byShort = new Map(packagesFile.map(entry => [entry.short, entry]));
const repoRoot = path.resolve(process.cwd(), '../../..');

describe('inside data', () => {
  // WHY: every row links to /packages/<short>. A short that is not in the generated list would be a dead link.
  it('names only packages that exist', () => {
    for (const row of rows) expect(byShort.has(row.short), `${row.feature}: ${row.short}`).toBe(true);
  });

  // WHY: the state pill is a promise about npm. "Shipped" with nothing on npm, or "planned" for a package that already
  // has a release candidate, would tell the reader the wrong thing about what they can install.
  it('shows the state that packages.json records', () => {
    for (const row of rows) {
      const entry = byShort.get(row.short);
      const actual = entry?.npmVersion ? 'shipped' : entry?.nextVersion ? 'candidate' : 'planned';
      expect(row.state, `${row.feature}: ${row.short}`).toBe(actual);
    }
  });

  // WHY: the page says "each code line is copied from the named file". A refactor that moves or edits those lines must
  // fail here, not leave the reader with code that is not in the repo.
  it('copies every proof exactly from its source lines', () => {
    const proofs = rows.flatMap(row => (row.proof === null ? [] : [row.proof]));
    expect(proofs.length).toBeGreaterThan(30);
    for (const { path: file, lines, code } of proofs) {
      const [from = 0, to = from] = lines.split('-').map(Number);
      const source = readFileSync(path.resolve(repoRoot, file), 'utf8').split('\n');
      expect(source.slice(from - 1, to).join('\n'), `${file}:${lines}`).toBe(code);
    }
  });

  // WHY: the founder keeps these three off the page; they are internal tools, not things a reader builds with.
  it('never lists expr, cas or bench', () => {
    for (const row of rows) expect(['expr', 'cas', 'bench']).not.toContain(row.short);
    expect(JSON.stringify(insideGroups)).not.toMatch(/@arki\/(expr|cas|bench)\b/);
  });

  // WHY: the journal plugin has no app using it yet; the page must say so instead of implying production use.
  it('says that no app uses the journal Dot plugin yet', () => {
    const row = rows.find(candidate => candidate.feature === 'The journal as a Dot plugin');
    expect(row && 'note' in row ? row.note : undefined).toBe('No app uses it yet.');
    expect(rows).toHaveLength(42);
  });
});
