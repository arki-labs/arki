/**
 * `site --check-links` must fail on every link a reader could click and land nowhere. The site is a fake fetcher
 * over a map of pages; source files live in a temp repo root.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FetchedPage } from './site-links';
import { checkSiteLinks, LINK_CHECK_ERROR_CODES } from './site-links';

let repoRoot: string;
beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'arki-links-'));
  mkdirSync(path.join(repoRoot, 'packages', 'async', 'src'), { recursive: true });
  writeFileSync(path.join(repoRoot, 'packages', 'async', 'src', 'errors.ts'), 'a\nb\nc\n');
});
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

const html = (body: string): FetchedPage => ({ status: 200, contentType: 'text/html; charset=utf-8', body });

function site(pages: Record<string, FetchedPage>) {
  return async (url: string): Promise<FetchedPage> =>
    pages[new URL(url).pathname] ?? { status: 404, contentType: 'text/html', body: 'Not found' };
}

const run = (pages: Record<string, FetchedPage>) =>
  checkSiteLinks({ baseUrl: 'http://site.test', repoRoot, seeds: ['/'], fetchPage: site(pages) });

describe('checkSiteLinks', () => {
  it('passes a site whose links, anchors and source links all resolve', async () => {
    const envelope = await run({
      '/': html('<a href="/docs#jobs">Docs</a> <a href="/errors/A_E001">E</a> <a href="https://example.com">out</a>'),
      '/docs': html(
        '<h2 id="jobs">Jobs</h2><a href="https://github.com/arki-labs/async/blob/main/LICENSE">license</a>',
      ),
      '/errors/A_E001': html('<a href="https://github.com/arki-labs/async/blob/HEAD/src/errors.ts#L3">src</a>'),
    });
    expect(envelope.status).toBe('success');
    expect(envelope.summary).toMatchObject({ pages: 3, links: 2, sourceLinks: 1, broken: 0 });
  });

  // A reader who clicks a link must land on a page, not a 404.
  it('reports an internal link to a missing page, once per page and link', async () => {
    const envelope = await run({ '/': html('<a href="/gone">x</a><a href="/gone">again</a>') });
    expect(envelope.status).toBe('failure');
    expect(envelope.items).toEqual([
      { code: LINK_CHECK_ERROR_CODES.brokenLink, from: '/', href: '/gone', reason: 'answers 404' },
    ]);
  });

  // A heading id changes when its text does; a stale `#anchor` drops the reader at the top of the page.
  it('reports a fragment that names no element', async () => {
    const envelope = await run({ '/': html('<a href="/docs#missing">x</a>'), '/docs': html('<h2 id="here">h</h2>') });
    expect(envelope.items.map(item => item.code)).toEqual([LINK_CHECK_ERROR_CODES.missingAnchor]);
  });

  // Error pages send readers to the mirror's source line; the mirror is `packages/<short>`, so the file and the line
  // must exist there.
  it('reports a source link with the wrong shape, a missing file or a line past the end', async () => {
    const envelope = await run({
      '/': html('<a href="/errors/A_E001">E</a>'),
      '/errors/A_E001': html(
        [
          '<a href="https://github.com/arki-labs/async/blob/HEAD/src/errors.ts">no line</a>',
          '<a href="https://github.com/arki-labs/async/blob/HEAD/src/gone.ts#L1">no file</a>',
          '<a href="https://github.com/arki-labs/async/blob/HEAD/src/errors.ts#L99">past the end</a>',
        ].join(''),
      ),
    });
    expect(envelope.items.map(item => item.reason)).toEqual([
      'not <mirror>/blob/HEAD/<path>#L<line>',
      'packages/async/src/gone.ts does not exist',
      'packages/async/src/errors.ts has 3 lines, not 99',
    ]);
  });

  it('fails loudly when the site does not answer', async () => {
    const envelope = await checkSiteLinks({
      baseUrl: 'http://site.test',
      repoRoot,
      seeds: ['/'],
      fetchPage: async () => {
        throw new Error('connection refused');
      },
    });
    expect(envelope.status).toBe('failure');
    expect(envelope.errors.map(error => error.code)).toEqual([LINK_CHECK_ERROR_CODES.unreachable]);
  });
});
