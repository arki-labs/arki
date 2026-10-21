import { createFileRoute, notFound } from '@tanstack/react-router';

import { DocBody } from '~/features/site-data/doc-body';
import { packageHref } from '~/features/site-data/package-urls';
import { getPackageDocFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';
import { DocsSidebar } from '~/shared/site-chrome';

import { newerDocs, wrapCheckSection } from '../../-doc-page';
import { bannerOf, withFocusableCode } from '../../-package-view';
import { withoutLeadingTitle } from '../../-readme-text';

/** Any doc of a snapshot by its path without `.md`: `/packages/dot/next/docs/quickstart`. */
export const Route = createFileRoute('/packages/$name/$version/$')({
  loader: async ({ params }) => {
    const path = params._splat ?? '';
    const page = await getPackageDocFn({ data: { short: params.name, version: params.version, path } });
    if (page === null) throw notFound();
    const newer = newerDocs(page.package, params.version);
    // The same doc in the newest folder, if it exists there; else the banner links to the package page.
    const newerPage =
      newer === null
        ? null
        : await getPackageDocFn({ data: { short: params.name, version: newer.folder, path: page.doc.path } });
    return { ...page, newer: newer === null ? null : { ...newer, hasDoc: newerPage !== null } };
  },
  head: ({ loaderData }) => {
    if (loaderData === undefined) return {};
    return getDefaultMeta({ title: `${loaderData.doc.title} | ${loaderData.package.name}@${loaderData.snapshot.version}` });
  },
  component: PackageDocPage,
});

function PackageDocPage() {
  const { package: entry, snapshot, doc, newer } = Route.useLoaderData();
  const { version } = Route.useParams();
  const versionHref = `${packageHref(entry.short)}/${version}`;
  const sections = doc.headings.filter(heading => heading.depth === 2);
  const note = snapshot.channel === 'next' || snapshot.archive ? bannerOf(entry, snapshot) : null;
  const sourceRef = snapshot.channel === 'next' ? 'main' : `v${snapshot.version}`;

  return (
    <div className="docs-row">
      <DocsSidebar />
      <main id="content">
        <article className="doc-article">
          <nav aria-label="Breadcrumb" className="mono pd-crumbs">
            <a href="/packages">Packages</a> <span aria-hidden="true">/</span>{' '}
            <a href={packageHref(entry.short)}>{entry.name}</a> <span aria-hidden="true">/</span>{' '}
            <a href={versionHref}>{snapshot.version}</a> <span aria-hidden="true">/</span>{' '}
            <span aria-current="page">{doc.title}</span>
          </nav>

          {newer !== null && (
            <div role="note" className="doc-older">
              <span aria-hidden="true">▲</span>
              <span>
                Older version. This page is for <code>{`${entry.name}@${snapshot.version}`}</code>. The latest release is{' '}
                <code>{newer.version}</code>.
              </span>
              <a href={newer.hasDoc ? `${packageHref(entry.short)}/${newer.folder}/${doc.path}` : packageHref(entry.short)}>
                Read the latest
              </a>
            </div>
          )}
          {note !== null && (
            <div className={note.kind === 'muted' ? 'banner bn-muted' : 'banner'} role="note">
              <span className="g" aria-hidden="true">
                {note.glyph}
              </span>
              <div>
                <p>
                  <strong>{note.title}</strong> {note.text}
                </p>
              </div>
            </div>
          )}

          <header>
            <h1>{doc.title}</h1>
            <p className="mono doc-for">
              For <code>{`${entry.name}@${snapshot.version}`}</code> ·{' '}
              <a href={`${entry.mirror}/blob/${sourceRef}/${doc.path}.md`}>source {doc.path}.md</a>
            </p>
          </header>

          <DocBody
            html={wrapCheckSection(withFocusableCode(withoutLeadingTitle(doc.html)))}
            headings={doc.headings}
            toc={false}
          />
          <p>
            <a href={versionHref}>All docs for {`${entry.name}@${snapshot.version}`}</a>
          </p>
        </article>
      </main>
      {sections.length > 0 && (
        <aside className="rail" aria-label="On this page">
          <h2>On this page</h2>
          <ul>
            {sections.map(heading => (
              <li key={heading.id}>
                <a href={`#${heading.id}`}>{heading.text}</a>
              </li>
            ))}
          </ul>
        </aside>
      )}
    </div>
  );
}
