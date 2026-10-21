import { createFileRoute } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';
import { glossaryLinkedPackages, inlineCodeParts, resolveGlossaryLink } from './-glossary';
import { getGlossaryFn } from './-glossary-page';
import { loadLatestDocs } from './-latest-docs';

export const Route = createFileRoute('/docs/glossary')({
  loader: async () => {
    const glossary = await getGlossaryFn();
    const shorts = glossaryLinkedPackages(glossary.terms.flatMap(term => term.readMore?.href ?? []));
    const loaded = await Promise.all(shorts.map(short => loadLatestDocs(short)));
    const latest = new Map(
      loaded.flatMap(entry =>
        entry === null
          ? []
          : [[entry.short, { folder: entry.folder, paths: entry.docs.map(doc => doc.path) }] as const],
      ),
    );
    return {
      ...glossary,
      // A link with no page on the site is dropped with its label: a "where to read" that leads nowhere is noise.
      terms: glossary.terms.map(term => {
        const href = term.readMore === null ? null : resolveGlossaryLink(term.readMore.href, latest);
        return {
          ...term,
          readMore: term.readMore === null || href === null ? null : { label: term.readMore.label, href },
        };
      }),
    };
  },
  head: () =>
    getDefaultMeta({ title: 'Glossary', description: 'The words the Arki docs use, one plain sentence each.' }),
  component: GlossaryPage,
});

/** Text with its `code` spans: glossary cells hold no other markup. */
function InlineCode({ text }: { text: string }) {
  return inlineCodeParts(text).map((part, index) =>
    part.code ? <code key={index}>{part.value}</code> : <span key={index}>{part.value}</span>,
  );
}

function GlossaryPage() {
  const { title, intro, columns, terms } = Route.useLoaderData();

  return (
    <main id="content">
      <div className="gl-wrap">
        <nav aria-label="Breadcrumb" className="dd-crumb">
          <a href="/docs">Docs</a> / <span aria-current="page">{title}</span>
        </nav>
        <h1 className="dd-h1">{title}</h1>
        {intro.map(paragraph => (
          <p key={paragraph} className="dd-lead">
            <InlineCode text={paragraph} />
          </p>
        ))}
        <p className="gl-count">
          {terms.length} terms · link to one with <code>/docs/glossary#&lt;term&gt;</code>
        </p>
        {/* Wide screens: one table. At 767px and below each row stacks (see site.css), so nothing scrolls sideways. */}
        <div role="region" aria-label="Glossary terms" className="gl-table">
          <table data-testid="glossary">
            <thead>
              <tr>
                {columns.map(column => (
                  <th key={column} scope="col">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {terms.map(term => (
                <tr key={term.id} id={term.id}>
                  <th scope="row">
                    <a href={`#${term.id}`}>
                      <InlineCode text={term.term} />
                      <span className="gl-hash" aria-hidden="true">
                        #
                      </span>
                    </a>
                  </th>
                  <td>
                    <span className="lbl lbl-meaning">What it means</span>
                    <InlineCode text={term.meaning} />
                  </td>
                  <td className={term.readMore === null ? 'gl-none' : undefined}>
                    <span className="lbl">Where to read</span>
                    {term.readMore !== null && (
                      <a href={term.readMore.href}>
                        <InlineCode text={term.readMore.label} />
                      </a>
                    )}
                  </td>
                  <td className={term.formerly === null ? 'gl-none gl-was' : 'gl-was'}>
                    <span className="lbl">Formerly</span>
                    {term.formerly !== null && <InlineCode text={term.formerly} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}
