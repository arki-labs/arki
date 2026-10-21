import { createFileRoute, Link } from '@tanstack/react-router';
import { z } from 'zod';

import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { listErrorsFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

import { ErrorSearchForm } from './-search-form';

export const Route = createFileRoute('/errors/')({
  validateSearch: z.object({ q: z.string().optional() }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => {
    const all = await listErrorsFn();
    const query = (deps.q ?? '').trim().toLowerCase();
    const matches =
      query === ''
        ? all
        : all.filter(entry => `${entry.code} ${entry.what} ${entry.package}`.toLowerCase().includes(query));
    const groups = Map.groupBy(matches, entry => entry.package);
    return {
      query: deps.q?.trim() ?? '',
      total: all.length,
      count: matches.length,
      groups: [...groups].toSorted(([a], [b]) => a.localeCompare(b)),
    };
  },
  head: () =>
    getDefaultMeta({
      title: 'Error codes',
      description: 'Every error code the Arki packages throw or return, with what happened and how to fix it.',
    }),
  component: ErrorsPage,
});

/** The first sentence of a doc comment, so a row stays one line. */
function firstSentence(text: string): string {
  const end = text.search(/[.!?](?:\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

function ErrorsPage() {
  const { query, total, count, groups } = Route.useLoaderData();

  return (
    <PageContainer breadcrumbs={{ items: [{ label: 'Error codes', href: '/errors' }] }}>
      <Shell className="sm:py-8 md:py-12">
        <h1>Error codes</h1>
        <p>
          Each code says what happened and how to fix it. A thrown error stops your code. A failure is a value a
          function returns, and you decide what to do with it.
        </p>
        <ErrorSearchForm defaultValue={query} />
        <p data-testid="errors-count">
          {query === '' ? `${total} codes` : `${count} of ${total} codes match "${query}"`}
        </p>
        {count === 0 ? (
          <p data-testid="errors-empty">No code matches. Try a shorter word, or clear the search.</p>
        ) : (
          groups.map(([packageName, entries]) => (
            <section key={packageName} aria-labelledby={`pkg-${packageName}`}>
              <h2 id={`pkg-${packageName}`}>{packageName}</h2>
              <ul>
                {entries.map(entry => (
                  <li key={entry.code} data-testid="error-row">
                    <Link to="/errors/$code" params={{ code: entry.code }}>
                      <code>{entry.code}</code>
                    </Link>{' '}
                    <span data-kind={entry.kind}>{entry.kind === 'thrown' ? 'Thrown' : 'Failure'}</span>{' '}
                    {firstSentence(entry.what)}
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </Shell>
    </PageContainer>
  );
}
