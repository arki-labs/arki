import { compileMarkdown } from '@arki/content-build/config';

import protocol from '~/content/agent-bench/PROTOCOL.md?raw';
import { demoteHeadings } from './-demote-headings';

/**
 * Server-only text for `/agents`: the agent benchmark protocol and, when the benchmark has run, its raw
 * `results.json`. Both are copies `bun release:arki site` keeps in `src/content/agent-bench/`, because the Docker
 * image has no repo-root `docs/`. Nothing here may reach the browser bundle.
 */

/**
 * The protocol as html, its headings one level down so its title sits under the page's h1. Its links point at repo
 * files, so they are dropped and only web links stay.
 */
export async function readProtocolPage() {
  return await compileMarkdown(demoteHeadings(protocol), {
    rewriteLink: href => (href.startsWith('http') || href.startsWith('#') ? undefined : null),
  });
}

const resultsFiles = import.meta.glob<string>('../../content/agent-bench/results.json', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** The raw text of `results.json`, or null while no benchmark has run. */
export function readResultsText(): string | null {
  return Object.values(resultsFiles)[0] ?? null;
}
