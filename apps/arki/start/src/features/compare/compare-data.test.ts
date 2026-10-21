import { describe, expect, it } from 'vitest';

import packagesFile from '~/generated/packages.json';

import { compareRows } from './compare-data';

// WHY: a `shipped` cell links to /packages/<short>. A package with status `none` has no docs page, so that link
// would be a 404. A cell must be `planned` until the package has a page.
describe('compare data', () => {
  const byShort = new Map(packagesFile.map(entry => [entry.short, entry]));

  it('links every shipped cell to a package that has a page', () => {
    for (const row of compareRows) {
      if (row.arki.state !== 'shipped') continue;
      const entry = byShort.get(row.arki.short);
      expect(entry, `${row.feature}: ${row.arki.short}`).toBeDefined();
      expect(entry?.status, `${row.feature}: ${row.arki.short}`).not.toBe('none');
    }
  });

  it('names a release wave or batch for every planned cell', () => {
    for (const row of compareRows) {
      if (row.arki.state === 'planned') expect(row.arki.wave.length).toBeGreaterThan(0);
    }
  });
});
