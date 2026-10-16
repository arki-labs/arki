import path from 'node:path';
import { remarkCodeHike } from '@code-hike/mdx';
import { defineCollection } from '@content-collections/core';
import remarkGfm from 'remark-gfm';

import { z } from '@arki/contracts';

import theme from '../lib/ch-theme.json' with { type: 'json' };
import { compileMDX } from '../lib/compile-mdx.js';
import resolveImageBlurDataURL from '../lib/imageBlurDataURL.js';
import mdxEmbedder from '../lib/mdxEmbedder/index.js';
import staticImages, { staticCoverImage } from '../lib/static-images.js';
import { addIdToHeadings } from '../plugins/add-id-to-headings.js';

const changelogDirectory = 'src/content/changelog';

type ImageParams = { image: string; directory: string };

async function collectImageInformation({ image, directory }: ImageParams) {
  const url = await staticCoverImage(changelogDirectory, 'public/changelog', '/changelog', directory, image);
  const blurDataURL = await resolveImageBlurDataURL(changelogDirectory, directory, image);
  return { url, blurDataURL };
}

export const changelogs = defineCollection({
  name: 'Changelogs',
  directory: 'src/content/changelog',
  include: '*/index.mdx',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    image: z.string(),
    publishedAt: z.coerce.date(),
    content: z.string(),
  }),
  transform: async (document, ctx) => {
    const mdx = await compileMDX(ctx, document, {
      files: appender => {
        const directory = path.join(changelogDirectory, document._meta.directory, 'components');
        appender.directory('./components', directory);
      },
      rehypePlugins: [
        addIdToHeadings,
        [
          staticImages,
          {
            publicDir: path.join('public', 'changelog'),
            resourcePath: '/changelog',
            sourceRoot: changelogDirectory,
          },
        ],
      ],
      remarkPlugins: [remarkGfm, mdxEmbedder, [remarkCodeHike, { theme, showCopyButton: true, autoImport: true }]],
    });

    // Not cached: a replaced image must get a new placeholder, and a deleted public copy must be copied again.
    const image = await collectImageInformation({ image: document.image, directory: document._meta.directory });

    return {
      ...document,
      content: {
        mdx,
        raw: document.content,
      },
      image,
      url: `/changelog/${document._meta.path}`,
      slug: document._meta.path,
    };
  },
});

export type ChangelogCollectionType = typeof changelogs;
