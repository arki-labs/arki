import type { getPackageDocFn } from './site-data';

type PackageDocPage = NonNullable<Awaited<ReturnType<typeof getPackageDocFn>>>;

type DocBodyProps = Pick<PackageDocPage['doc'], 'html' | 'headings'> & {
  /** Set for package docs: adds the version line and the `next` or archive banner. */
  snapshot?: Pick<PackageDocPage['snapshot'], 'name' | 'version' | 'channel' | 'archive'>;
};

/** The headings an on-page table of contents lists: the page title (H1) and deep sections are left out. */
const tocDepths = new Set([2, 3]);

/** One compiled doc (package doc or guide): version line, banner, table of contents and body. */
export function DocBody({ html, headings, snapshot }: DocBodyProps) {
  const toc = headings.filter(heading => tocDepths.has(heading.depth));
  return (
    <article>
      {snapshot !== undefined && (
        <header>
          <p className="text-sm text-muted-foreground">
            For <code>{`${snapshot.name}@${snapshot.version}`}</code>
          </p>
          {snapshot.channel === 'next' && <p role="note">Not on npm yet: candidate for v{snapshot.version}.</p>}
          {snapshot.archive && <p role="note">Archive, not supported.</p>}
        </header>
      )}
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
      {/* Compiled at build time from our own package docs by `compileMarkdown`; not user input. */}
      <div className="prose dark:prose-invert" dangerouslySetInnerHTML={{ __html: html }} />
    </article>
  );
}
