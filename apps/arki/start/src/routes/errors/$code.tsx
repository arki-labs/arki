import { createFileRoute, Link, notFound } from '@tanstack/react-router';

import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { packageHref } from '~/features/site-data/package-urls';
import { getErrorFn, listPackagesFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

import { ErrorSearchForm } from './-search-form';

export const Route = createFileRoute('/errors/$code')({
  loader: async ({ params }) => {
    const [error, packages] = await Promise.all([getErrorFn({ data: { code: params.code } }), listPackagesFn()]);
    if (error === null) throw notFound();
    return { error, owner: packages.find(entry => entry.name === error.package) ?? null };
  },
  head: ({ loaderData, params }) =>
    getDefaultMeta({
      title: `${params.code} error`,
      description: loaderData === undefined ? `The ${params.code} error code.` : loaderData.error.what,
    }),
  component: ErrorPage,
  notFoundComponent: ErrorNotFound,
});

/** `src/file.ts:12` as a link into the package's read-only mirror. `HEAD` follows the mirror's default branch. */
function sourceHref(mirror: string, source: string): string {
  const split = source.lastIndexOf(':');
  return `${mirror}/blob/HEAD/${source.slice(0, split)}#L${source.slice(split + 1)}`;
}

function ErrorPage() {
  const { error, owner } = Route.useLoaderData();

  return (
    <PageContainer
      breadcrumbs={{
        items: [
          { label: 'Error codes', href: '/errors' },
          { label: error.code, href: `/errors/${error.code}` },
        ],
      }}
    >
      <Shell className="sm:py-8 md:py-12">
        <h1>
          <code>{error.code}</code>
        </h1>
        <p data-kind={error.kind}>
          {error.kind === 'thrown'
            ? 'This error is thrown. It stops your code unless you catch it.'
            : 'This is a failure. A function returns it as a value, so your code keeps running and you decide what to do.'}
        </p>

        <h2>What happened</h2>
        <p>{error.what}</p>

        {error.fix !== null && (
          <>
            <h2>Fix</h2>
            <p>{error.fix}</p>
          </>
        )}

        {error.verify !== null && (
          <>
            <h2>Check the fix</h2>
            <pre>
              <code>{error.verify}</code>
            </pre>
          </>
        )}

        <h2>Where it comes from</h2>
        <ul>
          <li>
            Package:{' '}
            {owner === null ? <code>{error.package}</code> : <Link to={packageHref(owner.short)}>{error.package}</Link>}
          </li>
          <li>
            Version: {error.version} ({error.channel === 'next' ? 'next release candidate' : 'published'})
          </li>
          <li>
            Source:{' '}
            {owner === null ? (
              <code>{error.source}</code>
            ) : (
              <a href={sourceHref(owner.mirror, error.source)}>
                <code>{error.source}</code>
              </a>
            )}
          </li>
        </ul>
      </Shell>
    </PageContainer>
  );
}

function ErrorNotFound() {
  return (
    <PageContainer breadcrumbs={{ items: [{ label: 'Error codes', href: '/errors' }] }}>
      <Shell className="sm:py-8 md:py-12">
        <h1>No such error code</h1>
        <p>We have no error with this code. Search the list.</p>
        <ErrorSearchForm defaultValue="" />
        <p>
          <Link to="/errors">See all error codes</Link>
        </p>
      </Shell>
    </PageContainer>
  );
}
