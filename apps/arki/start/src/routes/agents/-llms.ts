import type { listPackagesFn } from '~/features/site-data/site-data';
import { latestSnapshotFolder, packageHref } from '~/features/site-data/package-urls';

type PackageRow = Awaited<ReturnType<typeof listPackagesFn>>[number];

/** The most lines `/llms.txt` may have. It is a map an agent reads whole, so it stays short. */
export const LLMS_INDEX_MAX_LINES = 80;

/** The one-line purpose of a package: the first `> ` line of its `llms.txt`. */
export function purposeOf(llmsText: string | null): string | null {
  return /^> (.+)$/m.exec(llmsText ?? '')?.[1] ?? null;
}

export type IndexPackage = {
  entry: Pick<PackageRow, 'name' | 'short' | 'status' | 'npmVersion'>;
  llmsText: string | null;
};

function packageLine({ entry, llmsText }: IndexPackage, baseUrl: string): string {
  const folder = latestSnapshotFolder(entry);
  const where = folder === null ? 'no release yet' : folder === 'next' ? 'next' : `v${folder}`;
  const purpose = purposeOf(llmsText) ?? 'No description yet.';
  return `- [${entry.name}](${baseUrl}${packageHref(entry.short)}): ${purpose} (${where})`;
}

/** `/llms.txt`: one line per package, then task docs, canonical links and verify commands. */
export function buildLlmsIndex(packages: readonly IndexPackage[], baseUrl: string): string {
  const lines = [
    '# Arki',
    '',
    '> Arki is a set of typed TypeScript libraries for building apps. This is the short map. The full text is in /llms-full.txt.',
    '',
    '## Packages',
    '',
    ...packages.map(item => packageLine(item, baseUrl)),
    '',
    '## Task docs',
    '',
    `- [Guides](${baseUrl}/docs/guides): step by step tasks`,
    `- [Glossary](${baseUrl}/docs/glossary): the words the docs use`,
    `- [Errors](${baseUrl}/errors): every error code, with its fix`,
    `- [Agent benchmark](${baseUrl}/agents): how we test agents on Arki, and the results`,
    '',
    '## Canonical',
    '',
    `- [Site](${baseUrl}/)`,
    `- [Full text for agents](${baseUrl}/llms-full.txt)`,
    '- [Source](https://github.com/arki-labs/arki)',
    '',
    '## Verify',
    '',
    '- Latest on npm: `npm view @arki/<name> version`',
    '- Release candidate: `bun add @arki/<name>@next`',
  ];
  return `${lines.join('\n')}\n`;
}

export type FullTextPackage = {
  entry: Pick<PackageRow, 'name' | 'short' | 'status' | 'npmVersion'>;
  llmsText: string | null;
  agentGuideText: string | null;
  agentsText: string | null;
};

/**
 * `/llms-full.txt`: the glossary first, then each package's `llms.txt`, `docs/agent-guide.md` and `AGENTS.md` for its
 * latest folder.
 */
export function buildLlmsFull(glossary: string, packages: readonly FullTextPackage[]): string {
  const sections = packages.flatMap(({ entry, llmsText, agentGuideText, agentsText }) => {
    const folder = latestSnapshotFolder(entry);
    if (folder === null) return [];
    const parts = [llmsText, agentGuideText, agentsText].filter((part): part is string => part !== null);
    if (parts.length === 0) return [];
    return [`${'='.repeat(3)} ${entry.name} (${folder}) ${'='.repeat(3)}\n\n${parts.join('\n\n')}`];
  });
  return `${[glossary.trim(), ...sections.map(section => section.trim())].join('\n\n')}\n`;
}
