import path from 'node:path';
import type { Meta } from '@content-collections/core';
import { remarkCodeHike } from '@code-hike/mdx';
import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import remarkGfm from 'remark-gfm';

import theme from '../lib/ch-theme.json' with { type: 'json' };
import resolveImageBlurDataURL from '../lib/imageBlurDataURL';
import mdxEmbedder from '../lib/mdxEmbedder';
import staticImages, { staticCoverImage } from '../lib/static-images';
import { addIdToHeadings } from '../plugins/add-id-to-headings';

const changelogDirectory = 'src/content/changelog';

type ImageParams = { image: string; directory: string };

async function collectImageInformation({ image, directory }: ImageParams) {
  const url = await staticCoverImage(changelogDirectory, 'public/changelog', '/changelog', directory, image);
  const blurDataURL = await resolveImageBlurDataURL(changelogDirectory, directory, image);
  return { url, blurDataURL };
}

export type Changelog = {
  title: string;
  description: string;
  publishedAt: Date;
  content: {
    mdx: string;
    raw: string;
  };
  image: {
    url: string;
    blurDataURL: string;
  };
  url: string;
  slug: string;
  _meta: Meta;
};

export const changelogs = defineCollection({
  name: 'Changelogs',
  directory: 'src/content/changelog',
  include: '*/index.mdx',
  schema: z => ({
    title: z.string(),
    description: z.string(),
    image: z.string(),
    publishedAt: z.coerce.date(),
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

    const image = await ctx.cache(
      { image: document.image, directory: document._meta.directory },
      collectImageInformation,
    );

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
