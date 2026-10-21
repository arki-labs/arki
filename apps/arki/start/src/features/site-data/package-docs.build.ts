import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import type { CompiledMarkdown, CompileMarkdownOptions } from '@arki/content-build/config';
import { compileMarkdown } from '@arki/content-build/config';
import { z } from '@arki/contracts';

/**
 * Build-time helpers for `content.config.ts` (node only, never imported by routes).
 *
 * content-collections loads its config with plain Node, which cannot import the TypeScript source of
 * `@arki/arki-release/site-schema`. So `packages.json` is read through the two fields the link rewrite needs,
 * locked to `PackageEntry` by `package-docs.build.test.ts`.
 */
export const packageMirrorListSchema = z.array(z.object({ short: z.string(), mirror: z.string() }));

let packageMirrors: z.output<typeof packageMirrorListSchema> | undefined;

/** Short name and GitHub mirror of every package in `src/generated/packages.json`, read once per build. */
export function readPackageMirrors(packagesFile: string) {
  packageMirrors ??= packageMirrorListSchema.parse(JSON.parse(readFileSync(packagesFile, 'utf8')));
  return packageMirrors;
}

const snapshotFiles = new Map<string, string[]>();

/** Snapshot-relative paths of the files in one `<short>/<version>/` folder, read once per build. */
export function readSnapshotFiles(snapshotDirectory: string): string[] {
  let files = snapshotFiles.get(snapshotDirectory);
  if (files === undefined) {
    files = readdirSync(snapshotDirectory, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => path.relative(snapshotDirectory, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
      .toSorted();
    snapshotFiles.set(snapshotDirectory, files);
  }
  return files;
}

/**
 * Compiles one markdown doc and picks its title: the frontmatter `title`, else the first H1, else the file name.
 * `cache` is the collection's cache; the caller keys it on everything the html depends on.
 */
export async function compileDoc(
  document: { title?: string | undefined; content: string; _meta: { fileName: string } },
  cache: (compute: () => Promise<CompiledMarkdown>) => Promise<CompiledMarkdown>,
  rewriteLink?: CompileMarkdownOptions['rewriteLink'],
) {
  const { html, headings } = await cache(() => compileMarkdown(document.content, { rewriteLink }));
  const firstH1 = headings.find(heading => heading.depth === 1)?.text;
  const title = document.title ?? firstH1 ?? document._meta.fileName.replace(/\.md$/, '');
  return { html, headings, title };
}
