/**
 * `site --check-links`: crawls the running arki site (a built `.output/server/index.mjs`, or the dev server) from a
 * few entry pages and reports every internal link that does not resolve:
 *
 * - an internal `<a href>` whose page does not answer 200,
 * - an internal `#fragment` with no element of that id on its page,
 * - an error page's source link that is not `<mirror>/blob/HEAD/<path>#L<line>`, or whose file or line is not in
 *   `packages/<short>/` of this repo (the mirror is built from that folder).
 *
 * External links are not fetched: they would make the check slow and flaky.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ReleaseCommandEnvelope, ReleaseError } from './types';
import { createEnvelope } from './json-output';

/** The pages the crawl starts from: every place a reader enters the docs. */
export const LINK_CHECK_SEEDS = [
  '/',
  '/docs',
  '/docs/guides',
  '/docs/glossary',
  '/docs/dot-new',
  '/docs/upgrade-story',
  '/packages',
  '/errors',
  '/compare',
  '/agents',
] as const;

export const LINK_CHECK_ERROR_CODES = {
  /** An internal link does not answer 200. */
  brokenLink: 'SITE_LINK_E001',
  /** An internal `#fragment` names no element on its page. */
  missingAnchor: 'SITE_LINK_E002',
  /** An error source link has the wrong shape, or its file or line is not in the repo. */
  badSourceLink: 'SITE_LINK_E003',
  /** The site did not answer at all. */
  unreachable: 'SITE_LINK_E004',
} as const;

/** What the crawl needs from one page. */
export interface FetchedPage {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
}

export type PageFetcher = (url: string) => Promise<FetchedPage>;

export interface LinkCheckOptions {
  /** Origin of the running site, e.g. `http://localhost:5181`. */
  readonly baseUrl: string;
  /** The repo root, where `packages/<short>/` holds each error's source file. */
  readonly repoRoot: string;
  readonly seeds?: readonly string[];
  readonly fetchPage?: PageFetcher;
  /** Stops the crawl after this many pages, so a link loop cannot run forever. */
  readonly maxPages?: number;
}

export interface BrokenLink {
  readonly code: (typeof LINK_CHECK_ERROR_CODES)[keyof typeof LINK_CHECK_ERROR_CODES];
  /** The page that holds the link. */
  readonly from: string;
  readonly href: string;
  readonly reason: string;
}

export interface LinkCheckSummary {
  readonly message: string;
  readonly pages: number;
  readonly links: number;
  readonly sourceLinks: number;
  readonly broken: number;
}

export type LinkCheckEnvelope = ReleaseCommandEnvelope<BrokenLink, LinkCheckSummary>;

const fetchWithBody: PageFetcher = async url => {
  const response = await fetch(url, { redirect: 'follow' });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
};

/** `href` values of every `<a>` in an HTML page, entities decoded. */
export function anchorHrefs(html: string): string[] {
  return [...html.matchAll(/<a\s[^>]*?href="([^"]*)"/g)].map(match => (match[1] ?? '').replaceAll('&amp;', '&'));
}

/** Every `id` in an HTML page. */
export function elementIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]*)"/g)].map(match => match[1] ?? ''));
}

/** `https://github.com/arki-labs/<short>/blob/HEAD/<path>#L<line>`, the link an error page gives for its source. */
const sourceLinkShape = /^https:\/\/github\.com\/arki-labs\/([\w.-]+)\/blob\/HEAD\/([^#\s]+)#L(\d+)$/;
/** Only an error page's GitHub links are source links; other GitHub links are external and not fetched. */
const isSourceLink = (pagePath: string, href: string): boolean =>
  pagePath.startsWith('/errors/') && /^https:\/\/github\.com\/arki-labs\/[^/]+\/blob\//.test(href);

/** Null when the source link points at a real line of a file in `packages/<short>/`; the reason otherwise. */
export async function sourceLinkProblem(href: string, repoRoot: string): Promise<string | null> {
  const match = sourceLinkShape.exec(href);
  if (match === null) return 'not <mirror>/blob/HEAD/<path>#L<line>';
  const [, short = '', file = '', line = '0'] = match;
  const text = await readFile(path.join(repoRoot, 'packages', short, file), 'utf8').catch(() => null);
  if (text === null) return `packages/${short}/${file} does not exist`;
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return Number(line) > lines ? `packages/${short}/${file} has ${String(lines)} lines, not ${line}` : null;
}

export async function checkSiteLinks(options: LinkCheckOptions): Promise<LinkCheckEnvelope> {
  const fetchPage = options.fetchPage ?? fetchWithBody;
  const origin = new URL(options.baseUrl).origin;
  const maxPages = options.maxPages ?? 5000;
  const broken: BrokenLink[] = [];
  const errors: ReleaseError[] = [];

  /** Page path → its ids (null when it is not an HTML page), filled as the crawl reaches it. */
  const visited = new Map<string, { status: number; ids: Set<string> | null }>();
  /** Every internal link found: page path, fragment, and where it was found. */
  const found: { from: string; href: string; target: string; fragment: string }[] = [];
  const sourceLinks = new Map<string, string>();
  const queue = [...(options.seeds ?? LINK_CHECK_SEEDS)];

  while (queue.length > 0 && visited.size < maxPages) {
    const pagePath = queue.shift() ?? '/';
    if (visited.has(pagePath)) continue;
    let page: FetchedPage;
    try {
      page = await fetchPage(`${origin}${pagePath}`);
    } catch (error) {
      errors.push({
        code: LINK_CHECK_ERROR_CODES.unreachable,
        severity: 'error',
        message: `${origin}${pagePath} did not answer: ${error instanceof Error ? error.message : String(error)}`,
        target: origin,
        remediation: 'Build the site and start it (`bun run build`, then `PORT=5181 bun .output/server/index.mjs`).',
      });
      break;
    }
    const html = page.status === 200 && page.contentType.includes('text/html');
    visited.set(pagePath, { status: page.status, ids: html ? elementIds(page.body) : null });
    if (!html) continue;

    for (const href of anchorHrefs(page.body)) {
      if (isSourceLink(pagePath, href)) {
        sourceLinks.set(href, pagePath);
        continue;
      }
      const url = new URL(href, `${origin}${pagePath}`);
      if (url.origin !== origin) continue;
      const target = url.pathname;
      found.push({ from: pagePath, href, target, fragment: decodeURIComponent(url.hash.slice(1)) });
      if (!visited.has(target)) queue.push(target);
    }
  }

  for (const link of found) {
    const target = visited.get(link.target);
    if (target === undefined) continue;
    if (target.status !== 200) {
      broken.push({
        code: LINK_CHECK_ERROR_CODES.brokenLink,
        from: link.from,
        href: link.href,
        reason: `answers ${String(target.status)}`,
      });
    } else if (link.fragment !== '' && target.ids !== null && !target.ids.has(link.fragment)) {
      broken.push({
        code: LINK_CHECK_ERROR_CODES.missingAnchor,
        from: link.from,
        href: link.href,
        reason: `no id "${link.fragment}" on ${link.target}`,
      });
    }
  }

  for (const [href, from] of sourceLinks) {
    const reason = await sourceLinkProblem(href, options.repoRoot);
    if (reason !== null) broken.push({ code: LINK_CHECK_ERROR_CODES.badSourceLink, from, href, reason });
  }

  const unique = [...new Map(broken.map(link => [`${link.from} ${link.href}`, link])).values()];
  for (const link of unique) {
    errors.push({
      code: link.code,
      severity: 'error',
      message: `${link.from} → ${link.href}: ${link.reason}`,
      target: link.from,
      remediation: 'Fix the link in the page or its source doc, then rebuild the site.',
    });
  }

  const status = errors.length > 0 ? 'failure' : 'success';
  return createEnvelope<BrokenLink, LinkCheckSummary>({
    command: 'site',
    status,
    summary: {
      message: `site --check-links: ${String(visited.size)} pages, ${String(found.length)} internal links, ${String(sourceLinks.size)} source links, ${String(unique.length)} broken.`,
      pages: visited.size,
      links: found.length,
      sourceLinks: sourceLinks.size,
      broken: unique.length,
    },
    items: unique,
    errors,
  });
}
