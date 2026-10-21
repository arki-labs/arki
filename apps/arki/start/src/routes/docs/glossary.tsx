import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';
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
    <PageContainer
      breadcrumbs={{
        items: [
          { label: 'Docs', href: '/docs' },
          { label: title, href: '/docs/glossary' },
        ],
      }}
    >
      <Shell className="sm:py-8 md:py-12">
        <h1>{title}</h1>
        {intro.map(paragraph => (
          <p key={paragraph}>
            <InlineCode text={paragraph} />
          </p>
        ))}
        {/* The table scrolls inside its own box so a 320px screen never scrolls the whole page sideways. */}
        <div className="max-w-full overflow-x-auto" role="region" aria-label="Glossary terms">
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
                    </a>
                  </th>
                  <td>
                    <InlineCode text={term.meaning} />
                  </td>
                  <td>
                    {term.readMore !== null && (
                      <a href={term.readMore.href}>
                        <InlineCode text={term.readMore.label} />
                      </a>
                    )}
                  </td>
                  <td>{term.formerly === null ? null : <InlineCode text={term.formerly} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Shell>
    </PageContainer>
  );
}
