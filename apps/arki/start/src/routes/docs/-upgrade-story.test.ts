import { describe, expect, it } from 'vitest';

import { demoteHtmlHeadings, upgradeDocsOf, upgradeStep } from './-upgrade-story';

describe('upgrade story helpers', () => {
  it('lists upgrade docs with the version-to-version doc first and drops the rest', () => {
    const docs = [
      { path: 'README' },
      { path: 'docs/upgrade-guide' },
      { path: 'docs/upgrades/0.6.1-to-0.7.0' },
      { path: 'docs/upgrade-phases' },
    ];
    expect(upgradeDocsOf(docs).map(doc => doc.path)).toEqual([
      'docs/upgrades/0.6.1-to-0.7.0',
      'docs/upgrade-guide',
      'docs/upgrade-phases',
    ]);
  });

  it('names the versions of a step doc and nothing for other docs', () => {
    expect(upgradeStep('docs/upgrades/0.6.1-to-0.7.0')).toBe('0.6.1 → 0.7.0');
    expect(upgradeStep('docs/upgrade-guide')).toBeNull();
  });

  it('demotes headings, keeps their attributes, and stops at h6', () => {
    expect(demoteHtmlHeadings('<h1 id="a" class="group">A</h1><h2>B</h2><h6>C</h6><hr>', 2)).toBe(
      '<h3 id="a" class="group">A</h3><h4>B</h4><h6>C</h6><hr>',
    );
  });
});
