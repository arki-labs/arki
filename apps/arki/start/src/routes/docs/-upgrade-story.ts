/** Pure helpers of `/docs/upgrade-story`: which docs it lists, in what order, and how the recipe html sits in the page. */

const upgradeDocPrefix = 'docs/upgrade';
const versionDocPrefix = 'docs/upgrades/';
const versionDocName = /^docs\/upgrades\/(.+)-to-(.+)$/;

/** The docs of a snapshot that are about upgrading, the version-to-version ones first (each in listing order). */
export function upgradeDocsOf<T extends { path: string }>(docs: readonly T[]): T[] {
  const upgrades = docs.filter(doc => doc.path.startsWith(upgradeDocPrefix));
  return [
    ...upgrades.filter(doc => doc.path.startsWith(versionDocPrefix)),
    ...upgrades.filter(doc => !doc.path.startsWith(versionDocPrefix)),
  ];
}

/** `0.6.1 → 0.7.0` for `docs/upgrades/0.6.1-to-0.7.0`; null for any other doc. */
export function upgradeStep(path: string): string | null {
  const match = versionDocName.exec(path);
  return match === null ? null : `${match[1]} → ${match[2]}`;
}

/**
 * Moves every heading of compiled html `levels` down (`h1` → `h3` for 2), at most to `h6`. The recipe has its own
 * `h1`; inside this page it must sit under the page's `h1` and `h2`.
 */
export function demoteHtmlHeadings(html: string, levels: number): string {
  return html.replaceAll(/<(\/?)h([1-6])\b/g, (_match, slash: string, level: string) => {
    return `<${slash}h${Math.min(6, Number(level) + levels)}`;
  });
}
