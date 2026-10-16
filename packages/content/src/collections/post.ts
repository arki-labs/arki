import { execFile as execFileCallback } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { remarkCodeHike } from '@code-hike/mdx';
import { defineCollection } from '@content-collections/core';
import readingTime from 'reading-time';
import remarkGfm from 'remark-gfm';

import { z } from '@arki/contracts';

import theme from '../lib/ch-theme.json' with { type: 'json' };
import { compileMDX } from '../lib/compile-mdx.js';
import resolveImageBlurDataURL from '../lib/imageBlurDataURL.js';
import mdxEmbedder from '../lib/mdxEmbedder/index.js';
import staticImages, { staticCoverImage } from '../lib/static-images.js';
import { addIdToHeadings } from '../plugins/add-id-to-headings.js';

const execFile = promisify(execFileCallback);

const postDirectory = 'src/content/posts';

function calculateReadingTime(content: string) {
  const contentWithoutSvg = content.replaceAll(/<svg.+?(?=<\/svg>)<\/svg>/gs, '');
  return readingTime(contentWithoutSvg).text;
}

/**
 * The date of the post's last commit, or `undefined` when git does not know it: no git, no repository (Docker
 * builds copy no `.git`), or an uncommitted file. Never "now": that would change on every build.
 */
async function lastCommitDate(filePath: string): Promise<{ date: string | undefined }> {
  try {
    const { stdout } = await execFile('git', ['log', '-1', '--format=%aI', '--', path.join(postDirectory, filePath)]);
    const date = stdout.trim();
    return { date: date === '' ? undefined : new Date(date).toISOString() };
  } catch {
    return { date: undefined };
  }
}

type ImageParams = { image: string; directory: string };

async function collectImageInformation({ image, directory }: ImageParams) {
  const url = await staticCoverImage(postDirectory, 'public/posts', '/posts', directory, image);
  const blurDataURL = await resolveImageBlurDataURL(postDirectory, directory, image);
  return { url, blurDataURL };
}

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
    /** Set it when the date matters; otherwise the post's last commit date is used, when git knows it. */
    lastModification: z.coerce.date().optional(),
    content: z.string(),
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

    const commit = await ctx.cache(post._meta.filePath, lastCommitDate);
    const lastModification = post.lastModification?.toISOString() ?? commit.date;
    // Not cached: a replaced image must get a new placeholder, and a deleted public copy must be copied again.
    const image = await collectImageInformation({ image: post.image, directory: post._meta.directory });

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
});

export type PostCollectionType = typeof posts;
