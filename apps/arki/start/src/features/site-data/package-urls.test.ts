import { describe, expect, it } from 'vitest';

import { latestSnapshotFolder, packageDocLinkRewriter } from './package-urls';

const files = ['README.md', 'LICENSE', 'docs/quickstart.md', 'docs/di.md', 'docs/examples/fixture.ts', 'llms.txt'];

function rewriter(filePath: string, version = '0.6.1') {
  return packageDocLinkRewriter({
    short: 'dot',
    version,
    filePath,
    files,
    mirror: 'https://github.com/arki-labs/dot',
    packages: ['dot', 'money'],
  });
}

describe('packageDocLinkRewriter', () => {
  it('sends links between docs of the snapshot to their site pages, keeping the anchor', () => {
    // Readers stay on the site and on the same version they are reading.
    expect(rewriter('README.md')('./docs/quickstart.md#install')).toBe('/packages/dot/0.6.1/docs/quickstart#install');
    expect(rewriter('docs/di.md')('../README.md')).toBe('/packages/dot/0.6.1/README');
    expect(rewriter('docs/di.md')('quickstart.md')).toBe('/packages/dot/0.6.1/docs/quickstart');
  });

  it('sends links to non-markdown files to the GitHub mirror at the version tag', () => {
    // The site does not serve source files or licenses; the mirror tag holds exactly the published files.
    expect(rewriter('README.md')('./LICENSE')).toBe('https://github.com/arki-labs/dot/blob/v0.6.1/LICENSE');
    expect(rewriter('docs/quickstart.md')('./examples/fixture.ts')).toBe(
      'https://github.com/arki-labs/dot/blob/v0.6.1/docs/examples/fixture.ts',
    );
  });

  it('uses the mirror `main` branch for an unreleased `next` snapshot, which has no tag yet', () => {
    expect(rewriter('README.md', 'next')('./LICENSE')).toBe('https://github.com/arki-labs/dot/blob/main/LICENSE');
    expect(rewriter('README.md', 'next')('./docs/di.md')).toBe('/packages/dot/next/docs/di');
  });

  it('sends a markdown link to a file the snapshot lacks to the mirror instead of a page that 404s', () => {
    // Archive snapshots keep only README and CHANGELOG, but their READMEs still link to docs.
    expect(rewriter('README.md')('./docs/missing.md')).toBe(
      'https://github.com/arki-labs/dot/blob/v0.6.1/docs/missing.md',
    );
  });

  it('sends a link to a sibling package to its landing page and drops any other link out of the package', () => {
    expect(rewriter('README.md')('../money/README.md')).toBe('/packages/money');
    expect(rewriter('README.md')('../money')).toBe('/packages/money');
    // Nothing public serves the monorepo outside a package, so the link becomes plain text.
    expect(rewriter('README.md')('../../apps/web/README.md')).toBeNull();
    expect(rewriter('README.md')('../unknown/README.md')).toBeNull();
  });

  it('leaves absolute URLs, site paths and in-page anchors alone', () => {
    const rewrite = rewriter('README.md');
    expect(rewrite('https://example.com/x.md')).toBeUndefined();
    expect(rewrite('mailto:security@example.com')).toBeUndefined();
    expect(rewrite('/errors')).toBeUndefined();
    expect(rewrite('#usage')).toBeUndefined();
  });
});

describe('latestSnapshotFolder', () => {
  it('reads the candidate for `next`, the npm version for `published` and `archive`, and nothing for `none`', () => {
    expect(latestSnapshotFolder({ status: 'next', npmVersion: '0.6.1' })).toBe('next');
    expect(latestSnapshotFolder({ status: 'published', npmVersion: '0.6.1' })).toBe('0.6.1');
    expect(latestSnapshotFolder({ status: 'archive', npmVersion: '0.0.3' })).toBe('0.0.3');
    expect(latestSnapshotFolder({ status: 'none', npmVersion: null })).toBeNull();
  });
});
