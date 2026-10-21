import { createFileRoute } from '@tanstack/react-router';

import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { packageHref } from '~/features/site-data/package-urls';
import { getDefaultMeta } from '~/shared-metadata';

import { listPackageRowsFn } from './-package-data';
import { TIER_GROUPS } from './-tiers';

export const Route = createFileRoute('/packages/')({
  loader: () => listPackageRowsFn(),
  head: () =>
    getDefaultMeta({
      title: 'Packages',
      description: 'Every @arki package: tier, status, versions, runtimes and doc example results.',
    }),
  component: PackagesPage,
});

type PackageRow = Awaited<ReturnType<typeof listPackageRowsFn>>[number];

const columnCount = 7;

function examplesText(examples: PackageRow['examples']): string {
  if (examples === null) return 'none recorded';
  return `${examples.compiled} compiled, ${examples.run} run, ${examples.skipped} skipped`;
}

function runtimesText(runtimes: PackageRow['runtimes']): string {
  const entries = Object.entries(runtimes);
  if (entries.length === 0) return 'not declared';
  return entries.map(([runtime, range]) => `${runtime} ${range}`).join(', ');
}

function PackagesPage() {
  const rows = Route.useLoaderData();
  const groups = TIER_GROUPS.map(group => ({ ...group, rows: rows.filter(row => row.tier === group.tier) })).filter(
    group => group.rows.length > 0,
  );

  return (
    <PageContainer breadcrumbs={{ items: [{ label: 'Packages', href: '/packages' }] }}>
      <Shell className="sm:py-8 md:py-12">
        <h1>Packages</h1>
        <p>
          Status <code>published</code> means the latest docs come from npm. <code>next</code> means they come from a
          release candidate that is not on npm yet. <code>archive</code> means only an old README is kept.{' '}
          <code>none</code> means nothing is published yet.
        </p>
        <p>
          <a href="/packages/index.json">This list as JSON</a>
        </p>
        <div className="overflow-x-auto">
          <table aria-label="Packages">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Purpose</th>
                <th scope="col">Status</th>
                <th scope="col">npm</th>
                <th scope="col">Next</th>
                <th scope="col">Runtimes</th>
                <th scope="col">Doc examples</th>
              </tr>
            </thead>
            {groups.map(group => (
              <tbody key={String(group.tier)}>
                <tr>
                  <th scope="rowgroup" colSpan={columnCount}>
                    {group.label}
                  </th>
                </tr>
                {group.rows.map(row => (
                  <tr key={row.short} data-package={row.short}>
                    <th scope="row">
                      <a href={packageHref(row.short)}>{row.name}</a>
                    </th>
                    <td>
                      {row.purpose ?? (row.status === 'none' ? 'No docs published yet.' : 'The README has no summary.')}
                    </td>
                    <td>
                      <code>{row.status}</code>
                    </td>
                    <td>{row.npmVersion ?? 'not published'}</td>
                    <td>{row.nextVersion ?? 'none'}</td>
                    <td>{runtimesText(row.runtimes)}</td>
                    <td>{examplesText(row.examples)}</td>
                  </tr>
                ))}
              </tbody>
            ))}
          </table>
        </div>
      </Shell>
    </PageContainer>
  );
}
