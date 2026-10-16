import { defineCollection } from '@content-collections/core';
import remarkGfm from 'remark-gfm';

import { z } from '@arki/contracts';

import { compileMDX } from '../lib/compile-mdx.js';
import { addIdToHeadings } from '../plugins/add-id-to-headings.js';

export const legals = defineCollection({
  name: 'Legals',
  directory: 'src/content/legal',
  include: '**/*.mdx',
  schema: z.object({
    title: z.string(),
    updatedAt: z.string(),
    content: z.string(),
  }),
  transform: async (document, context) => {
    const mdx = await compileMDX(context, document, {
      remarkPlugins: [remarkGfm],
      rehypePlugins: [addIdToHeadings],
    });
    return {
      ...document,
      mdx,
      slug: document._meta.fileName.replace(/\.mdx$/, ''),
    };
  },
});

export type LegalCollectionType = typeof legals;
