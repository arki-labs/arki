import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

import { Pill } from '~/shared/site-chrome';
import { packageHref } from '~/features/site-data/package-urls';
import { getDefaultMeta } from '~/shared-metadata';

import { listPackageRowsFn } from './-package-data';
import {
  examplesText,
  filterPackages,
  groupByTier,
  runtimesText,
  STATUS_PILL,
  statusFromSearch,
  totalLine,
} from './-package-list';

export const Route = createFileRoute('/packages/')({
  validateSearch: z.object({
    q: z.string().optional(),
    status: z.string().optional(),
  }),
  loader: () => listPackageRowsFn(),
  head: () =>
    getDefaultMeta({
      title: 'Packages',
      description: 'Every @arki package: tier, status, versions, runtimes and doc example results.',
    }),
  component: PackagesPage,
});

function PackagesPage() {
  const rows = Route.useLoaderData();
  const { q = '', status: statusParam } = Route.useSearch();
  const status = statusFromSearch(statusParam);
  const { shown, chips } = filterPackages(rows, q, status);
  const groups = groupByTier(shown);
  const query = q.trim();

  return (
    <main id="content" className="pk-main">
      <h1>Packages</h1>
      <p className="pk-lede">
        Tier 1 is the app stack. Tier 2 libraries work on their own. <code>published</code> docs come from npm;{' '}
        <code>next</code> docs come from a release candidate that is not on npm yet. <code>archive</code> keeps only an
        old README. <code>none</code> means nothing is published yet.
      </p>
      <p className="mono pk-total">
        {totalLine(rows)} · <a href="/packages/index.json">this list as JSON</a>
      </p>

      <form method="get" action="/packages" role="search" aria-label="Filter packages" className="pk-form">
        {/* First submit button of the form, so Enter in the search box keeps the status picked now. */}
        <button type="submit" name="status" value={status} className="pk-sr">
          Apply filter
        </button>
        <label htmlFor="pkg-q" className="pk-sr">
          Filter by name or purpose
        </label>
        <div className="pk-search">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <input id="pkg-q" name="q" type="search" defaultValue={q} placeholder="Filter by name or purpose" />
        </div>
        <div role="group" aria-label="Status" className="pk-chips">
          {chips.map(chip => (
            <button key={chip.id} type="submit" name="status" value={chip.id} className="chip" aria-pressed={status === chip.id}>
              {chip.id === 'all' ? 'All' : chip.id} <span className="mono pk-count">{chip.count}</span>
            </button>
          ))}
        </div>
      </form>

      <p role="status" className="mono pk-result">
        {shown.length === rows.length ? `Showing all ${rows.length}` : `Showing ${shown.length} of ${rows.length}`}
      </p>

      {shown.length > 0 ? (
        <table aria-label="Packages" className="cards pk-table">
          <thead>
            <tr>
              <th scope="col">Package</th>
              <th scope="col">Purpose</th>
              <th scope="col">Status</th>
              <th scope="col">npm → next</th>
              <th scope="col">Doc examples</th>
            </tr>
          </thead>
          {groups.map(group => (
            <tbody key={String(group.tier)}>
              <tr>
                <th scope="rowgroup" colSpan={5} className="pk-group">
                  {group.label} <span className="pk-group-count">· {group.rows.length}</span>
                </th>
              </tr>
              {group.rows.map(row => {
                const runtimes = runtimesText(row.runtimes);
                const pill = STATUS_PILL[row.status];
                return (
                  <tr key={row.short} className="card-row" data-package={row.short}>
                    <th scope="row">
                      <a className="pname" href={packageHref(row.short)}>
                        {row.name}
                      </a>
                      {runtimes !== null && <div className="mono pk-runtimes">{runtimes}</div>}
                    </th>
                    <td className="c-full pk-purpose">
                      {row.purpose ?? (row.status === 'none' ? 'No docs published yet.' : 'The README has no summary.')}
                    </td>
                    <td className="c-end">
                      <Pill kind={pill.kind} glyph={pill.glyph}>
                        {row.status}
                      </Pill>
                    </td>
                    <td className="mono pk-ver">
                      <span className="lbl">npm → next</span>
                      {row.npmVersion ?? '—'} → {row.nextVersion ?? '—'}
                    </td>
                    <td className="mono pk-ex">
                      <span className="lbl">Examples</span>
                      {examplesText(row.examples)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      ) : (
        <div className="pk-empty">
          {query === '' ? (
            <p className="pk-empty-title">No package has this status.</p>
          ) : (
            <>
              <p className="pk-empty-title">
                No package matches <code>{query}</code>.
              </p>
              <p className="pk-empty-hint">
                The filter looks at package names and the first line of each README. Error codes and API names live
                elsewhere:
              </p>
            </>
          )}
          <ul>
            {query !== '' && (
              <li>
                <a href={`/errors?q=${encodeURIComponent(query)}`}>Search error codes for “{query}”</a>
              </li>
            )}
            <li>
              <a href="/packages">Clear the filter</a>
            </li>
          </ul>
        </div>
      )}
    </main>
  );
}
