import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';
import { z } from '@arki/schema';

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
  }),
  transform: async (document, context) => {
    const mdx = await compileMDX(context, document, {
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
