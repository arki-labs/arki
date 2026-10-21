import path from 'node:path';

import { defineCollection, defineContentConfig } from '@arki/content-build/config';
import { changelogs, faqs, legals, posts } from '@arki/content-build/presets';
import { z } from '@arki/contracts';

import { compileDoc, readPackageMirrors, readSnapshotFiles } from './src/features/site-data/package-docs.build';
import { packageDocLinkRewriter } from './src/features/site-data/package-urls';

/**
 * Package docs copied by `bun release:arki site` from npm tarballs
 * (`<short>/<version>/`) or the newest release candidate (`<short>/next/`).
 * Never hand-edited: the folder layout gives package, version and page path.
 * Relative links are rewritten to site pages or the GitHub mirror (see `packageDocLinkRewriter`).
 */
const packageDocs = defineCollection({
  name: 'PackageDocs',
  directory: 'src/content/packages',
  include: '**/*.md',
  schema: z.object({
    title: z.string().optional(),
    content: z.string(),
  }),
  transform: async (document, context) => {
    const [short = '', version = '', ...rest] = document._meta.path.split('/');
    const contentRoot = context.collection.directory;
    const packageMirrors = readPackageMirrors(path.join(contentRoot, '../../generated/packages.json'));
    const shorts = packageMirrors.map(entry => entry.short);
    const mirror = packageMirrors.find(entry => entry.short === short)?.mirror;
    if (mirror === undefined) throw new Error(`${document._meta.filePath}: package "${short}" is not in packages.json`);
    const files = readSnapshotFiles(path.join(contentRoot, short, version));
    const rewriteLink = packageDocLinkRewriter({
      short,
      version,
      filePath: rest.join('/') + '.md',
      files,
      mirror,
      packages: shorts,
    });
    const compiled = await compileDoc(
      document,
      // Links depend on the snapshot's files and the package list, so both are part of the key.
      compute =>
        context.cache({ content: document.content, path: document._meta.filePath, mirror, files, shorts }, compute),
      rewriteLink,
    );
    return { ...document, ...compiled, package: `@arki/${short}`, version, path: rest.join('/') };
  },
});

/** Task-named guides (`src/content/guides/<task>.md`) that cut across packages. */
const guides = defineCollection({
  name: 'Guides',
  directory: 'src/content/guides',
  include: '**/*.md',
  schema: z.object({
    title: z.string().optional(),
    content: z.string(),
  }),
  transform: async (document, context) => ({
    ...document,
    ...(await compileDoc(document, compute => context.cache(document.content, compute))),
    slug: document._meta.path,
  }),
});

export default defineContentConfig({ content: [posts, legals, faqs, changelogs, packageDocs, guides] });
