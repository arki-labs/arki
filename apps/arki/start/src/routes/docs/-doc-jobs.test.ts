import { describe, expect, test } from 'vitest';

import { DOC_JOBS, resolveDocLinks } from './-doc-jobs';

const heading = (depth: number, text: string, id: string) => ({ depth, text, id });

const latest = new Map([
  [
    'dot',
    {
      folder: 'next',
      docs: [
        { path: 'docs/quickstart', title: 'Quickstart', headings: [] },
        { path: 'docs/agent-guide', title: 'DOT for Agents', headings: [heading(3, 'Add a feature', 'add-a-feature')] },
      ],
    },
  ],
]);

describe('resolveDocLinks', () => {
  test('links a doc in the latest snapshot, titled from the doc', () => {
    expect(resolveDocLinks([{ short: 'dot', path: 'docs/quickstart' }], latest)).toEqual([
      { href: '/packages/dot/next/docs/quickstart', title: 'Quickstart' },
    ]);
  });

  test('a section ref links the heading and names it', () => {
    expect(resolveDocLinks([{ short: 'dot', path: 'docs/agent-guide', hash: 'add-a-feature' }], latest)).toEqual([
      { href: '/packages/dot/next/docs/agent-guide#add-a-feature', title: 'DOT for Agents: Add a feature' },
    ]);
  });

  // A renamed heading should not cost the reader the whole doc.
  test('a missing section falls back to the doc', () => {
    expect(resolveDocLinks([{ short: 'dot', path: 'docs/agent-guide', hash: 'gone' }], latest)).toEqual([
      { href: '/packages/dot/next/docs/agent-guide', title: 'DOT for Agents' },
    ]);
  });

  // Doc paths change between versions; the index must never link a page that 404s.
  test('a doc or package missing from the latest snapshots is left out', () => {
    expect(resolveDocLinks([{ short: 'dot', path: 'docs/gone' }], latest)).toEqual([]);
    expect(resolveDocLinks([{ short: 'unknown', path: 'README' }], latest)).toEqual([]);
  });
});

describe('DOC_JOBS', () => {
  // The docs index promises these five jobs in this order (plan T3.3); anchors on /docs use the ids.
  test('lists the five jobs in reading order', () => {
    expect(DOC_JOBS.map(job => job.id)).toEqual([
      'create-an-app',
      'add-a-feature',
      'inspect-a-failure',
      'deploy',
      'upgrade',
    ]);
  });
});
