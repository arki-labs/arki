import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';

import { z } from '@arki/contracts';

import { addIdToHeadings } from '../plugins/add-id-to-headings';

export const faqs = defineCollection({
  name: 'FAQs',
  directory: 'src/content/faq',
  include: '**/*.mdx',
  schema: z.object({
    title: z.string(),
    order: z.number(),
    content: z.string(),
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

export type FaqCollectionType = typeof faqs;
