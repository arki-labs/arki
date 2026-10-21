import { describe, expect, it } from 'vitest';

import { activeMainLink } from './main-links';

describe('activeMainLink', () => {
  // WHY: recipes live under /packages/... but a reader reaches them from Docs; highlighting Packages tells them they left.
  it('marks package docs (recipes, guides) as Docs', () => {
    expect(activeMainLink('/packages/dot/next/docs/recipes/deploy')).toBe('/docs');
  });

  it('keeps package pages under Packages', () => {
    expect(activeMainLink('/packages')).toBe('/packages');
    expect(activeMainLink('/packages/dot')).toBe('/packages');
    expect(activeMainLink('/packages/dot/next')).toBe('/packages');
  });

  it('matches a section by whole path segment', () => {
    expect(activeMainLink('/docs/glossary')).toBe('/docs');
    expect(activeMainLink('/inside')).toBe('/inside');
    expect(activeMainLink('/insidery')).toBeNull();
    expect(activeMainLink('/errors')).toBeNull();
  });
});
