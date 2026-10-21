import { createFileRoute, Link } from '@tanstack/react-router';
import * as z from 'zod/mini';

import { packageHref } from '~/features/site-data/package-urls';
import { listErrorsFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { Pill } from '~/shared/site-chrome';
import { ErrorSearchForm } from './-search-form';

/** The first sentence of a doc comment, so a row stays one line. */
function firstSentence(text: string): string {
  const end = text.search(/[.!?](?:\s|$)/);
  return end === -1 ? text : text.slice(0, end + 1);
}

/** `@arki/dot` -> `dot`: the short name that package URLs and anchors use. */
function shortName(packageName: string): string {
  return packageName.slice(packageName.indexOf('/') + 1);
}

function codeCount(count: number): string {
  return `${count} ${count === 1 ? 'code' : 'codes'}`;
}

export const Route = createFileRoute('/errors/')({
  validateSearch: z.object({ q: z.optional(z.string()) }),
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => {
    const all = await listErrorsFn();
    const query = (deps.q ?? '').trim().toLowerCase();
    const matches =
      query === ''
        ? all
        : all.filter(entry =>
            `${entry.code} ${entry.package} ${firstSentence(entry.what)}`.toLowerCase().includes(query),
          );
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

function ErrorsPage() {
  const { query, total, count, groups } = Route.useLoaderData();
  const countLine =
    query === '' ? `${total} codes in ${groups.length} packages` : `${count} of ${total} codes match "${query}"`;

  return (
    <main id="content" className="errors-main">
      <h1 className="e-title">Error codes</h1>
      <p className="e-lede">
        Each code says what happened and how to fix it. A thrown error stops your code. A failure is a value a function
        returns, and you decide what to do with it.
      </p>
      <p className="e-legend">
        <span>
          <Pill kind="k-thrown" glyph="▲">
            thrown
          </Pill>{' '}
          <span className="e-muted">stops your code unless you catch it</span>
        </span>
        <span>
          <Pill kind="k-failure" glyph="◇">
            failure
          </Pill>{' '}
          <span className="e-muted">returned as a value for you to handle</span>
        </span>
      </p>
      <ErrorSearchForm defaultValue={query} />
      <p role="status" className="sub e-count" data-testid="errors-count">
        {countLine}
      </p>
      {query === '' && (
        <nav aria-label="Packages with error codes" className="e-jump">
          {groups.map(([packageName, entries]) => (
            <a key={packageName} className="chip" href={`#pkg-${shortName(packageName)}`}>
              <span className="mono">{packageName}</span> <span className="mono e-n">{entries.length}</span>
            </a>
          ))}
        </nav>
      )}
      {count === 0 ? (
        <div className="e-nomatch" data-testid="errors-empty">
          <p className="e-nomatch-title">
            No code matches <code>{query}</code>.
          </p>
          <p className="e-muted">The search looks at codes, package names and the first line of what happened.</p>
          <ul>
            <li>Try a shorter word, or part of the code.</li>
            <li>
              <Link to="/errors">Clear the search</Link>
            </li>
          </ul>
        </div>
      ) : (
        groups.map(([packageName, entries]) => {
          const short = shortName(packageName);
          return (
            <section key={packageName} aria-labelledby={`pkg-${short}`}>
              <h2 id={`pkg-${short}`} className="pkgh">
                <Link to={packageHref(short)}>{packageName}</Link>{' '}
                <span className="n">{codeCount(entries.length)}</span>
              </h2>
              <table className="cards" aria-label={`Error codes in ${packageName}`}>
                <thead>
                  <tr>
                    <th scope="col" className="e-col-code">
                      Code
                    </th>
                    <th scope="col" className="e-col-kind">
                      Kind
                    </th>
                    <th scope="col">What happened</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map(entry => (
                    <tr key={entry.code} className="card-row" data-testid="error-row">
                      <th scope="row" className="e-cell-code">
                        <Link className="ecode" to="/errors/$code" params={{ code: entry.code }}>
                          {entry.code}
                        </Link>
                      </th>
                      <td className="c-end" data-kind={entry.kind}>
                        <Pill
                          kind={entry.kind === 'thrown' ? 'k-thrown' : 'k-failure'}
                          glyph={entry.kind === 'thrown' ? '▲' : '◇'}
                        >
                          {entry.kind}
                        </Pill>
                      </td>
                      <td className="c-full e-muted">{firstSentence(entry.what)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })
      )}
    </main>
  );
}
