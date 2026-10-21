import { createFileRoute, Link, notFound } from '@tanstack/react-router';

import { findRemovedCode } from '~/features/errors/removed-codes';
import { packageDocHref, packageHref } from '~/features/site-data/package-urls';
import { getErrorFn, listPackagesFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { CodeBlock, Pill } from '~/shared/site-chrome';
import { ErrorSearchForm } from './-search-form';

export const Route = createFileRoute('/errors/$code')({
  loader: async ({ params }) => {
    const [error, packages] = await Promise.all([getErrorFn({ data: { code: params.code } }), listPackagesFn()]);
    if (error !== null) {
      return { view: 'live' as const, error, owner: packages.find(entry => entry.name === error.package) ?? null };
    }
    const removed = findRemovedCode(params.code);
    if (removed === null) throw notFound();
    return { view: 'removed' as const, removed };
  },
  head: ({ loaderData, params }) =>
    getDefaultMeta({
      title: `${params.code} error`,
      description:
        loaderData === undefined
          ? `The ${params.code} error code.`
          : loaderData.view === 'live'
            ? loaderData.error.what
            : loaderData.removed.meant,
    }),
  component: ErrorPage,
  notFoundComponent: ErrorNotFound,
});

/** `src/file.ts:12` as a link into the package's read-only mirror. `HEAD` follows the mirror's default branch. */
function sourceHref(mirror: string, source: string): string {
  const split = source.lastIndexOf(':');
  return `${mirror}/blob/HEAD/${source.slice(0, split)}#L${source.slice(split + 1)}`;
}

function Breadcrumb({ code }: { code: string }) {
  return (
    <nav aria-label="Breadcrumb" className="mono e-crumb">
      <Link to="/errors">Error codes</Link> <span aria-hidden="true">/</span>{' '}
      <span aria-current="page" className="e-break">
        {code}
      </span>
    </nav>
  );
}

function Rail({ items }: { items: readonly { href: string; label: string }[] }) {
  return (
    <aside className="rail" aria-label="On this page">
      {items.length > 0 && (
        <>
          <h2>On this page</h2>
          <ul>
            {items.map(item => (
              <li key={item.href}>
                <a href={item.href}>{item.label}</a>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Also</h2>
      <ul>
        <li>
          <Link to="/errors">All error codes</Link>
        </li>
        <li>
          <Link to="/docs/glossary">Glossary</Link>
        </li>
      </ul>
    </aside>
  );
}

function ErrorPage() {
  const data = Route.useLoaderData();

  if (data.view === 'removed') {
    const { removed } = data;
    return (
      <main id="content" className="errors-main">
        <div className="e-layout">
          <div className="e-body">
            <Breadcrumb code={removed.code} />
            <div className="banner bn-muted" role="note">
              <span aria-hidden="true" className="g">
                ▪
              </span>
              <div>
                <p className="e-flush">
                  <strong>
                    This code was removed in {removed.package} {removed.removedIn}.
                  </strong>{' '}
                  The same case is now the failure{' '}
                  <Link to="/errors/$code" params={{ code: removed.replacedBy }} className="mono">
                    {removed.replacedBy}
                  </Link>
                  .
                </p>
                <p className="e-flush e-muted e-gap">
                  Moving from {removed.lastVersion}? Read{' '}
                  <a href={packageDocHref(removed.short, 'next', removed.upgradeDoc)}>
                    Upgrade {removed.package} {removed.lastVersion} to {removed.removedIn}
                  </a>{' '}
                  and <Link to="/docs/upgrade-story">how upgrades work</Link>.
                </p>
              </div>
            </div>
            <h1 className="e-code">{removed.code}</h1>
            <p className="intro intro-removed">
              <Pill kind="st-muted" glyph="▪">
                removed
              </Pill>
              This code no longer exists. Code that matches on it will never see it again.
            </p>
            <section className="sec" aria-labelledby="what">
              <h2 id="what">What it meant</h2>
              <p>{removed.meant}</p>
            </section>
            <section className="sec" aria-labelledby="where">
              <h2 id="where">Where it came from</h2>
              <dl className="facts">
                <dt>Package</dt>
                <dd>
                  <Link to={packageHref(removed.short)} className="mono">
                    {removed.package}
                  </Link>
                </dd>
                <dt>Version</dt>
                <dd>
                  last in {removed.lastVersion} · removed in {removed.removedIn}
                </dd>
                <dt>Source</dt>
                <dd>
                  <code>{removed.source}</code> <span className="e-muted">in {removed.lastVersion}</span>
                </dd>
              </dl>
            </section>
          </div>
          <Rail
            items={[
              { href: '#what', label: 'What it meant' },
              { href: '#where', label: 'Where it came from' },
            ]}
          />
        </div>
      </main>
    );
  }

  const { error, owner } = data;
  const railItems = [
    { href: '#what', label: 'What happened' },
    ...(error.fix === null ? [] : [{ href: '#fix', label: 'Fix' }]),
    ...(error.verify === null ? [] : [{ href: '#check', label: 'Check the fix' }]),
    { href: '#where', label: 'Where it comes from' },
  ];

  return (
    <main id="content" className="errors-main">
      <div className="e-layout">
        <div className="e-body">
          <Breadcrumb code={error.code} />
          <h1 className="e-code">{error.code}</h1>
          <p className={`intro intro-${error.kind}`} data-kind={error.kind}>
            <Pill kind={error.kind === 'thrown' ? 'k-thrown' : 'k-failure'} glyph={error.kind === 'thrown' ? '▲' : '◇'}>
              {error.kind}
            </Pill>
            {error.kind === 'thrown'
              ? 'This error is thrown. It stops your code unless you catch it. Fix the cause below; catching it only hides the problem.'
              : 'This is a failure. A function returns it as a value, so your code keeps running and you decide what to do.'}
          </p>

          <section className="sec" aria-labelledby="what">
            <h2 id="what">What happened</h2>
            <p>{error.what}</p>
          </section>

          {error.fix !== null && (
            <section className="sec" aria-labelledby="fix">
              <h2 id="fix">Fix</h2>
              <p>{error.fix}</p>
            </section>
          )}

          {error.verify !== null && (
            <section className="sec" aria-labelledby="check">
              <h2 id="check">Check the fix</h2>
              <CodeBlock code={error.verify} label="Command that checks the fix" copyLabel="Copy the check command" />
              <p className="e-muted e-note">Run it after the fix. It passes when the fix worked.</p>
            </section>
          )}

          <section className="sec" aria-labelledby="where">
            <h2 id="where">Where it comes from</h2>
            <dl className="facts">
              <dt>Package</dt>
              <dd>
                {owner === null ? (
                  <code>{error.package}</code>
                ) : (
                  <Link to={packageHref(owner.short)} className="mono">
                    {error.package}
                  </Link>
                )}
              </dd>
              <dt>Version</dt>
              <dd>
                {error.version} · {error.channel === 'next' ? 'next release candidate' : 'published'}
              </dd>
              <dt>Source</dt>
              <dd>
                {owner === null ? (
                  <code>{error.source}</code>
                ) : (
                  <a href={sourceHref(owner.mirror, error.source)} className="mono">
                    {error.source}
                  </a>
                )}
              </dd>
            </dl>
          </section>
        </div>
        <Rail items={railItems} />
      </div>
    </main>
  );
}

function ErrorNotFound() {
  const { code } = Route.useParams();
  return (
    <main id="content" className="errors-main">
      <div className="e-layout">
        <div className="e-body">
          <Breadcrumb code={code} />
          <p className="mono sub e-404">404</p>
          <h1 className="e-title e-tight">No such error code</h1>
          <p className="e-lede-lg">
            There is no error with the code <code>{code}</code>. Search the list, or check the code for a typo.
          </p>
          <ErrorSearchForm defaultValue={code} mono />
          <p>
            <Link to="/errors">See all error codes</Link>
          </p>
        </div>
        <Rail items={[]} />
      </div>
    </main>
  );
}
