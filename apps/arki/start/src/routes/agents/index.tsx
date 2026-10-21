import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';
import { createFileRoute } from '@tanstack/react-router';

import { latestSnapshotFolder, packageDocHref, packageHref } from '~/features/site-data/package-urls';
import { listPackagesFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { getAgentsPageFn } from './-agents-page';

export const Route = createFileRoute('/agents/')({
  loader: async () => {
    const [page, packages] = await Promise.all([getAgentsPageFn(), listPackagesFn()]);
    return { page, packages };
  },
  head: () =>
    getDefaultMeta({
      title: 'Agent benchmark',
      description: 'How we test AI coding agents on Arki, the protocol we fixed before any run, and the results.',
    }),
  component: AgentsPage,
});

function AgentsPage() {
  const { page, packages } = Route.useLoaderData();
  const breadcrumbs = { items: [{ label: 'Agent benchmark', href: '/agents' }] };

  return (
    <PageContainer breadcrumbs={breadcrumbs}>
      <Shell className="sm:py-8 md:py-12">
        <h1>Agent benchmark</h1>

        <section aria-labelledby="agents-results">
          <h2 id="agents-results">Results</h2>
          {page.resultsText === null ? (
            <p data-testid="agents-empty">
              No results yet. The benchmark has not run. This page shows the protocol only, so you can see how we will
              measure before we have a number.
            </p>
          ) : (
            <>
              <p>Raw results, as the harness wrote them.</p>
              <pre data-testid="agents-results">{page.resultsText}</pre>
            </>
          )}
        </section>

        <section aria-label="Protocol">
          {/* Compiled on the server from our own protocol file by `compileMarkdown`; not user input. */}
          <div
            data-testid="agents-protocol"
            className="prose dark:prose-invert"
            dangerouslySetInnerHTML={{ __html: page.protocol.html }}
          />
        </section>

        <section aria-labelledby="agents-library-benchmarks">
          <h2 id="agents-library-benchmarks">Library benchmarks</h2>
          <p>
            These are separate from the agent benchmark. Each package keeps its numbers, method and raw data in its
            README. This page shows none of them.
          </p>
          <table data-testid="agents-library-benchmarks">
            <thead>
              <tr>
                <th scope="col">Package</th>
                <th scope="col">Bench status</th>
                <th scope="col">Bench section</th>
              </tr>
            </thead>
            <tbody>
              {packages.map(entry => {
                const folder = latestSnapshotFolder(entry);
                return (
                  <tr key={entry.short}>
                    <td>
                      <a href={packageHref(entry.short)}>{entry.name}</a>
                    </td>
                    <td>{entry.benchStatus}</td>
                    <td>
                      {folder === null || entry.benchStatus === 'none' ? (
                        'No benchmark'
                      ) : (
                        <a href={`${packageDocHref(entry.short, folder, 'README')}#benchmarks`}>README, Benchmarks</a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      </Shell>
    </PageContainer>
  );
}
