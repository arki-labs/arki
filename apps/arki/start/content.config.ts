import { defineCollection, defineContentConfig } from '@arki/content-build/config';
import { changelogs, faqs, legals, posts } from '@arki/content-build/presets';
import { z } from '@arki/contracts';

/**
 * Package docs copied by `bun release:arki site` from npm tarballs
 * (`<short>/<version>/`) or the newest release candidate (`<short>/next/`).
 * Never hand-edited: the folder layout gives package, version and page path.
 */
const packageDocs = defineCollection({
  name: 'PackageDocs',
  directory: 'src/content/packages',
  include: '**/*.md',
  schema: z.object({
    title: z.string().optional(),
    content: z.string(),
  }),
  transform: document => {
    const [short = '', version = '', ...rest] = document._meta.path.split('/');
    return { ...document, package: `@arki/${short}`, version, path: rest.join('/') };
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
  transform: document => ({ ...document, slug: document._meta.path }),
});

export default defineContentConfig({ content: [posts, legals, faqs, changelogs, packageDocs, guides] });
