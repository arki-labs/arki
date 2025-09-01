import { exec as syncExec } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Meta } from '@content-collections/core';
import { remarkCodeHike } from '@code-hike/mdx';
import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import readingTime from 'reading-time';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';

import theme from '../lib/ch-theme.json' with { type: 'json' };
import resolveImageBlurDataURL from '../lib/imageBlurDataURL';
import mdxEmbedder from '../lib/mdxEmbedder';
import searchIndex from '../lib/searchIndex';
import staticImages, { staticCoverImage } from '../lib/static-images';
import withoutBody from '../lib/withoutBody';
import { addIdToHeadings } from '../plugins/add-id-to-headings';

const exec = promisify(syncExec);

const postDirectory = 'src/content/posts';

function calculateReadingTime(content: string) {
  const contentWithoutSvg = content.replaceAll(/<svg.+?(?=<\/svg>)<\/svg>/gs, '');
  return readingTime(contentWithoutSvg).text;
}

async function lastModificationDate(filePath: string) {
  const { stdout } = await exec(`git log -1 --format=%ai -- ${path.join(postDirectory, filePath)}`);
  if (stdout) {
    return new Date(stdout.trim()).toISOString();
  }
  return new Date().toISOString();
}

type ImageParams = { image: string; directory: string };

async function collectImageInformation({ image, directory }: ImageParams) {
  const url = await staticCoverImage(postDirectory, 'public/posts', '/posts', directory, image);
  const blurDataURL = await resolveImageBlurDataURL(postDirectory, directory, image);
  return { url, blurDataURL };
}

export type Post = {
  title: string;
  description: string;
  publishedAt: Date;
  author: {
    name: string;
    url?: string;
    avatar?: string;
  };
  tags: string[];
  content: {
    mdx: string;
    raw: string;
  };
  readingTime: string;
  lastModification: string;
  image: {
    url: string;
    blurDataURL: string;
  };
  url: string;
  slug: string;
  _meta: Meta;
};

export const posts = defineCollection({
  name: 'posts',
  directory: postDirectory,
  include: '*/index.mdx',
  schema: z.object({
    title: z.string(),
    description: z.string(),
    image: z.string(),
    publishedAt: z.coerce.date(),
    author: z.object({
      name: z.string(),
      url: z.string().optional(),
      avatar: z.string().optional(),
    }),
    tags: z.array(z.string()),
  }),
  transform: async (post, ctx) => {
    const mdx = await compileMDX(ctx, post, {
      files: appender => {
        const directory = path.join(postDirectory, post._meta.directory, 'components');
        appender.directory('./components', directory);
      },
      rehypePlugins: [
        addIdToHeadings,
        [
          staticImages,
          {
            publicDir: path.join('public', 'posts'),
            resourcePath: '/posts',
            sourceRoot: postDirectory,
          },
        ],
      ],
      remarkPlugins: [remarkGfm, mdxEmbedder, [remarkCodeHike, { theme, showCopyButton: true, autoImport: true }]],
    });

    const lastModification = await ctx.cache(post._meta.filePath, lastModificationDate);
    const image = await ctx.cache({ image: post.image, directory: post._meta.directory }, collectImageInformation);

    return {
      ...post,
      content: {
        mdx,
        raw: post.content,
      },
      readingTime: calculateReadingTime(post.content),
      lastModification,
      image,
      url: `/posts/${post._meta.path}`,
      slug: post._meta.path,
    };
  },
  onSuccess: async documents => {
    await Promise.all([withoutBody(documents, '.generated'), searchIndex(documents, '.generated')]);
  },
});

export type PostCollectionType = typeof posts;
