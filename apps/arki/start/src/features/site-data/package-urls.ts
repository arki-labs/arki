import type { PackageEntry } from '@arki/arki-release/site-schema';

/**
 * Site URLs of package pages, and the rule that turns links inside package docs into them. Pure and isomorphic:
 * `content.config.ts` uses it at build time and routes use it in the browser.
 */

/** A package's landing page. */
export function packageHref(short: string): string {
  return `/packages/${short}`;
}

/**
 * One doc page. `version` is the snapshot folder (an npm version or `next`); `path` is the doc's path in the
 * snapshot without `.md` (`README`, `docs/quickstart`).
 */
export function packageDocHref(short: string, version: string, path: string): string {
  return `/packages/${short}/${version}/${path}`;
}

/** The snapshot folder a package's "latest" page reads, or null when the package has none (`status: none`). */
export function latestSnapshotFolder(entry: Pick<PackageEntry, 'status' | 'npmVersion'>): string | null {
  if (entry.status === 'next') return 'next';
  if (entry.status === 'none') return null;
  return entry.npmVersion;
}

const schemePrefix = /^[a-z][a-z\d+.-]*:/i;
const markdownExtension = '.md';

/** `target` resolved against `directory`; `up` counts the `..` steps that left the snapshot root. */
function resolveRelative(directory: string, target: string): { up: number; segments: string[] } {
  const segments = directory === '' ? [] : directory.split('/');
  let up = 0;
  for (const part of target.split('/')) {
    if (part === '' || part === '.') continue;
    if (part !== '..') segments.push(part);
    else if (segments.length > 0) segments.pop();
    else up += 1;
  }
  return { up, segments };
}

export type PackageDocLinkContext = {
  short: string;
  /** Snapshot folder: an npm version or `next`. */
  version: string;
  /** The doc's file path in the snapshot, with `.md` (`docs/quickstart.md`). */
  filePath: string;
  /** Every file the snapshot holds (`snapshot.json` `files`). */
  files: readonly string[];
  /** The package's GitHub mirror (`packages.json` `mirror`). */
  mirror: string;
  /** Short names of every package the site lists. */
  packages: readonly string[];
};

/**
 * The `rewriteLink` for one package doc (see `compileMarkdown`). Absolute URLs, `/paths` and `#anchors` stay.
 * A relative link to a markdown file in the snapshot goes to its site page; any other file in the package goes to
 * the GitHub mirror at the snapshot's tag (`v<version>`, or `main` for `next`). A link out of the package goes to
 * the landing page of the package it names (`../money/README.md`); any other link out is dropped, keeping its
 * text, because nothing public serves it.
 */
export function packageDocLinkRewriter(context: PackageDocLinkContext): (href: string) => string | null | undefined {
  const mirrorRef = context.version === 'next' ? 'main' : `v${context.version}`;
  const docs = new Set(context.files.filter(file => file.endsWith(markdownExtension)));
  const siblings = new Set(context.packages);
  const slash = context.filePath.lastIndexOf('/');
  const directory = slash === -1 ? '' : context.filePath.slice(0, slash);

  return href => {
    if (href === '' || href.startsWith('#') || href.startsWith('/') || schemePrefix.test(href)) return;
    const hashAt = href.indexOf('#');
    const target = hashAt === -1 ? href : href.slice(0, hashAt);
    const hash = hashAt === -1 ? '' : href.slice(hashAt);
    const { up, segments } = resolveRelative(directory, target);

    if (up > 0) {
      // The snapshot is `packages/<short>/` in the source tree, so one step up lands among the other packages.
      const [sibling, ...rest] = segments;
      const pointsAtLanding = rest.length === 0 || (rest.length === 1 && rest[0] === 'README.md');
      if (up === 1 && sibling !== undefined && siblings.has(sibling) && pointsAtLanding) return packageHref(sibling);
      return null;
    }

    const resolved = segments.join('/');
    if (docs.has(resolved)) {
      return packageDocHref(context.short, context.version, resolved.slice(0, -markdownExtension.length)) + hash;
    }
    return `${context.mirror}/blob/${mirrorRef}/${resolved}${hash}`;
  };
}
