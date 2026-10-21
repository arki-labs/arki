import type { getPackageDocFn } from './site-data';

type PackageDocPage = NonNullable<Awaited<ReturnType<typeof getPackageDocFn>>>;

type DocBodyProps = Pick<PackageDocPage['doc'], 'html' | 'headings'> & {
  /** False when the page draws its own "On this page" list (a rail); default true. */
  toc?: boolean;
};

/** The headings an on-page table of contents lists: the page title (H1) and deep sections are left out. */
const tocDepths = new Set([2, 3]);

/** One compiled doc (package doc or guide): optional table of contents and the body. Styled by `.doc-body` in site.css. */
export function DocBody({ html, headings, toc: showToc = true }: DocBodyProps) {
  const toc = showToc ? headings.filter(heading => tocDepths.has(heading.depth)) : [];
  return (
    <article>
      {toc.length > 0 && (
        <nav aria-label="On this page">
          <ul>
            {toc.map(heading => (
              <li key={heading.id} data-depth={heading.depth}>
                <a href={`#${heading.id}`}>{heading.text}</a>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {/* Compiled at build time from our own package docs by `compileMarkdown`; not user input. A wide table scrolls
          inside its own box so a 320px screen never scrolls the whole page sideways. */}
      <div
        className="doc-body prose dark:prose-invert [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </article>
  );
}
