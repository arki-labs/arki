import { packageDocHref, packageHref } from '../../features/site-data/package-urls';

/**
 * The glossary is one markdown table (`src/content/glossary/glossary.md`, a copy of the repo's
 * `docs/arki/glossary.md`). `content.config.ts` turns its rows into terms at build time; `/docs/glossary` resolves
 * their links and renders them as a table with one anchor per term. Pure, so the build and the route share it.
 */

/** The anchor of a term's row: lower case, words joined by `-` (`service witness` → `service-witness`). */
export function glossaryTermId(term: string): string {
  return term
    .toLowerCase()
    .replaceAll(/[^a-z\d]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}

// The glossary sits at `docs/arki/`, so a package file is two steps up.
const packageFileLink = /^\.\.\/\.\.\/packages\/([^/]+)\/([^#]+)(#.*)?$/;
const webLink = /^https?:\/\//;

/** The package and file a glossary link points at, or null for any other link. */
function packageFileOf(href: string) {
  const match = packageFileLink.exec(href);
  if (match === null) return null;
  const [, short = '', file = '', hash = ''] = match;
  return { short, file, hash };
}

/** Short names of the packages the glossary links into: the route loads their latest docs to resolve the links. */
export function glossaryLinkedPackages(hrefs: readonly string[]): string[] {
  return [...new Set(hrefs.flatMap(href => packageFileOf(href)?.short ?? []))];
}

/** A package's latest snapshot folder and the doc paths in it (without `.md`), keyed by short name. */
export type LatestDocPaths = ReadonlyMap<string, { folder: string; paths: readonly string[] }>;

/**
 * The site URL of a glossary link, or null to drop the link and keep its text. A package doc goes to its page in
 * the package's latest snapshot, a package README to the package page. Repo-only files (`.agents/…`,
 * `CONTRIBUTING.md`, plans) and docs the latest snapshot lacks have no page on the site.
 */
export function resolveGlossaryLink(href: string, latest: LatestDocPaths): string | null {
  if (webLink.test(href)) return href;
  const target = packageFileOf(href);
  if (target === null || !target.file.endsWith('.md')) return null;
  const docPath = target.file.slice(0, -'.md'.length);
  const snapshot = latest.get(target.short);
  if (snapshot === undefined || !snapshot.paths.includes(docPath)) return null;
  if (docPath === 'README') return packageHref(target.short) + target.hash;
  return packageDocHref(target.short, snapshot.folder, docPath) + target.hash;
}

const markdownLink = /^\[(.+)\]\((.+)\)$/;
const inlineMarkup = /\]\(|\*\*/;

/** Cells of one table row (`| a | b |`), trimmed. */
function cellsOf(line: string): string[] {
  return line
    .slice(1, -1)
    .split('|')
    .map(cell => cell.trim());
}

/** A cell of plain text and `code` spans; anything richer would be shown as raw markdown, so it fails the build. */
function plainCell(cell: string, where: string): string {
  if (inlineMarkup.test(cell)) throw new Error(`glossary: ${where} uses markdown the page does not render: ${cell}`);
  return cell;
}

/**
 * Title, intro paragraphs, column names and terms of the glossary; links keep their repo-relative href.
 * Throws when the file changes shape, so the build fails instead of the page.
 */
export function parseGlossary(markdown: string) {
  const lines = markdown.split('\n');
  const titleAt = lines.findIndex(line => line.startsWith('# '));
  const tableAt = lines.findIndex(line => line.startsWith('|'));
  if (titleAt === -1 || tableAt === -1 || tableAt < titleAt)
    throw new Error('glossary: needs a "# " title, then a table');
  const title = lines[titleAt]?.slice(2).trim() ?? '';

  const intro = lines
    .slice(titleAt + 1, tableAt)
    .join('\n')
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.replaceAll(/\s*\n\s*/g, ' ').trim())
    .filter(paragraph => paragraph !== '');

  const tableEnd = lines.findIndex((line, index) => index > tableAt && !line.startsWith('|'));
  const [header = '', , ...rows] = lines.slice(tableAt, tableEnd === -1 ? undefined : tableEnd);
  const columns = cellsOf(header);
  if (columns.length !== 4) throw new Error(`glossary: expected 4 columns, got ${columns.length}: ${header}`);

  const terms = rows.map(row => {
    const cells = cellsOf(row);
    if (cells.length !== columns.length) throw new Error(`glossary: row has ${cells.length} cells: ${row}`);
    const [term = '', meaning = '', readMore = '', formerly = ''] = cells;
    const link = markdownLink.exec(readMore);
    if (readMore !== '' && link === null) throw new Error(`glossary: "${term}" read-more cell is not one link`);
    return {
      id: glossaryTermId(term),
      term: plainCell(term, term),
      meaning: plainCell(meaning, term),
      readMore: link === null ? null : { label: plainCell(link[1] ?? '', term), href: link[2] ?? '' },
      formerly: formerly === '' ? null : plainCell(formerly, term),
    };
  });

  const ids = terms.map(term => term.id);
  const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
  if (repeated !== undefined) throw new Error(`glossary: two terms share the anchor #${repeated}`);

  return { title, intro, columns, terms };
}

/** Splits text on backticks: odd parts were `code`. Glossary cells hold no other markup (`plainCell` checks). */
export function inlineCodeParts(text: string) {
  return text.split('`').map((value, index) => ({ value, code: index % 2 === 1 }));
}
