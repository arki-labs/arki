import type { AnyCollection } from '@content-collections/core';
import { defineCollection } from '@content-collections/core';
import { compileMDX } from '@content-collections/mdx';

import { addIdToHeadings } from '../plugins/add-id-to-headings';

export type Faq = {
  title: string;
  order: number;
  mdx: string;
  slug: string;
};

export const faqs: AnyCollection = defineCollection({
  name: 'FAQs',
  directory: 'src/content/faq',
  include: '**/*.mdx',
  schema: z => ({
    title: z.string(),
    order: z.number(),
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
