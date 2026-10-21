import { describe, expect, test } from 'vitest';

import {
  glossaryLinkedPackages,
  glossaryTermId,
  inlineCodeParts,
  parseGlossary,
  resolveGlossaryLink,
} from './-glossary';

const latest = new Map([['dot', { folder: 'next', paths: ['README', 'docs/quickstart'] }]]);

describe('resolveGlossaryLink', () => {
  // The glossary is written for the repo; on the site a package doc lives under its latest snapshot.
  test('a package doc goes to its page in the latest snapshot', () => {
    expect(resolveGlossaryLink('../../packages/dot/docs/quickstart.md', latest)).toBe(
      '/packages/dot/next/docs/quickstart',
    );
  });

  test('a package README goes to the package page', () => {
    expect(resolveGlossaryLink('../../packages/dot/README.md', latest)).toBe('/packages/dot');
  });

  // A link to a doc the latest snapshot lacks would 404, so it is dropped and its text stays.
  test('a doc missing from the latest snapshot is dropped', () => {
    expect(resolveGlossaryLink('../../packages/dot/docs/gone.md', latest)).toBeNull();
    expect(resolveGlossaryLink('../../packages/unknown/README.md', latest)).toBeNull();
  });

  // `.agents/…`, `CONTRIBUTING.md` and repo docs are not served by the site.
  test('repo-only files are dropped', () => {
    expect(resolveGlossaryLink('../../.agents/skills/arki-release/SKILL.md', latest)).toBeNull();
    expect(resolveGlossaryLink('../../CONTRIBUTING.md', latest)).toBeNull();
    expect(resolveGlossaryLink('core-packages.md', latest)).toBeNull();
  });
});

describe('parseGlossary', () => {
  const source = [
    '# Glossary',
    '',
    'The words the docs use.',
    'One per row.',
    '',
    '| Term | What it means | Where to read | Formerly |',
    '|---|---|---|---|',
    '| service witness | A `service<T>()` marker. | [Quickstart](../../packages/dot/docs/quickstart.md) | Pip |',
    '| wave | A set of packages. | [Release skill](../../.agents/skills/arki-release/SKILL.md) | |',
    '',
    'After the table.',
  ].join('\n');

  test('turns rows into terms with an anchor, keeping the repo-relative link for the route to resolve', () => {
    const glossary = parseGlossary(source);
    expect(glossary.title).toBe('Glossary');
    expect(glossary.intro).toEqual(['The words the docs use. One per row.']);
    expect(glossary.columns).toEqual(['Term', 'What it means', 'Where to read', 'Formerly']);
    expect(glossary.terms).toEqual([
      {
        id: 'service-witness',
        term: 'service witness',
        meaning: 'A `service<T>()` marker.',
        readMore: { label: 'Quickstart', href: '../../packages/dot/docs/quickstart.md' },
        formerly: 'Pip',
      },
      {
        id: 'wave',
        term: 'wave',
        meaning: 'A set of packages.',
        readMore: { label: 'Release skill', href: '../../.agents/skills/arki-release/SKILL.md' },
        formerly: null,
      },
    ]);
    // Only package links need the latest snapshot, so the route loads just those packages.
    expect(glossaryLinkedPackages(glossary.terms.map(term => term.readMore?.href ?? ''))).toEqual(['dot']);
  });

  // The page renders cells as text and `code` only, so richer markdown must fail the build, not show raw.
  test('fails on a link inside a meaning cell', () => {
    const withLink = source.replace('A set of packages.', 'See [here](x.md).');
    expect(() => parseGlossary(withLink)).toThrow(/markdown the page does not render/);
  });

  // Two terms with one anchor would make `#id` links land on the wrong row.
  test('fails when two terms share an anchor', () => {
    const repeated = source.replace('| wave |', '| Service Witness |');
    expect(() => parseGlossary(repeated)).toThrow(/share the anchor #service-witness/);
  });

  test('fails when a row has the wrong number of cells', () => {
    expect(() => parseGlossary(source.replace('| Pip |', '|'))).toThrow(/row has 3 cells/);
  });
});

describe('glossaryTermId and inlineCodeParts', () => {
  test('ids are what a reader types after #', () => {
    expect(glossaryTermId('X-ray')).toBe('x-ray');
    expect(glossaryTermId('leaf library')).toBe('leaf-library');
  });

  test('backticks split text into plain and code parts', () => {
    expect(inlineCodeParts('made with `defineFailure`, not thrown')).toEqual([
      { value: 'made with ', code: false },
      { value: 'defineFailure', code: true },
      { value: ', not thrown', code: false },
    ]);
  });
});
