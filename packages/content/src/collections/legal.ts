import { z } from '@arki/contracts';
import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import remarkGfm from 'remark-gfm';

import { addIdToHeadings } from '../plugins/add-id-to-headings';

export type Legal = {
  title: string;
  updatedAt: string;
  mdx: string;
  slug: string;
};

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
